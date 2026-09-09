// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

/**
 * @title  AderaRegistry
 * @notice Sovereign, decentralized OCPI party directory for the ADERA framework
 *         (Automated Decentralized Energy Roaming Architecture).
 *
 * @dev    DESIGN PRINCIPLES
 *         -----------------
 *         1. ZERO-TRUST DIRECTORY. The ledger stores ONLY the minimum needed to
 *            discover and cryptographically authenticate a counterparty:
 *               - the OCPI Party ID  (ISO-3166 country code "LK" + 3-char id)
 *               - the bound legal-entity governance key (`entity`)
 *               - an OPAQUE, encrypted OCPI endpoint blob (`endpointCipher`)
 *               - the party's messaging public key (`pubKey`)
 *               - an `active` status flag
 *            No CDRs, no tariffs, no sessions, no PII. All operational data and
 *            P2P traffic live strictly OFF-CHAIN (see gateway.js).
 *
 *         2. IDENTITY BINDING. A Party ID is bound 1:1 to exactly one legal
 *            entity key. The binding is immutable while the party is admitted:
 *            it can only be dissolved by a multisig REVOKE. This is the core
 *            defense against identity hijacking / endpoint spoofing — a rogue
 *            key can never mutate another party's record.
 *
 *         3. MULTISIG GOVERNANCE. New parties are admitted only by an M-of-N
 *            vote of the existing admitted operators. The same mechanism governs
 *            revocation, reinstatement, membership and the threshold itself.
 *
 *         4. REGULATOR AUDITOR. A dedicated, powerless-by-design observer role. It
 *            can read everything (all state is public) and can emit on-chain
 *            `ComplianceProbe` attestations proving oversight was exercised, but
 *            it can never mutate the registry. Regulatory visibility without a
 *            central point of control or failure.
 *
 *         This contract has NO external imports so it compiles with a bare
 *         `solc` invocation inside the adera-contract-deployer container.
 */
contract AderaRegistry {
    // ---------------------------------------------------------------------
    // Types
    // ---------------------------------------------------------------------

    enum Role {
        None, // 0 - unset / sentinel
        CPO,  // 1 - Charge Point Operator
        EMSP, // 2 - e-Mobility Service Provider
        HUB   // 3 - Roaming hub (optional; ADERA is hubless, reserved)
    }

    enum ActionType {
        AdmitParty,     // 0
        RevokeParty,    // 1
        ReinstateParty, // 2
        AddMember,      // 3
        RemoveMember,   // 4
        SetThreshold,   // 5
        TransferAuditor // 6
    }

    struct Party {
        bytes2  countryCode;    // e.g. 0x4c4b == "LK"
        bytes3  partyId;        // e.g. 0x43504f == "CPO"
        Role    role;
        address entity;         // bound legal-entity governance key (unique)
        bytes   endpointCipher; // opaque AES-256-GCM ciphertext of OCPI versions URL
        bytes   pubKey;         // 64-byte uncompressed secp256k1 messaging pubkey
        bool    active;
        uint64  admittedAt;
        uint64  updatedAt;
        bool    exists;
    }

    struct FoundingParty {
        bytes2  countryCode;
        bytes3  partyId;
        Role    role;
        address entity;
        bytes   endpointCipher;
        bytes   pubKey;
    }

    struct Proposal {
        ActionType action;
        bytes      payload;       // abi-encoded, action-specific
        address    proposer;
        uint64     createdAt;
        uint32     confirmations;
        bool       executed;
        bool       cancelled;
    }

    // ---------------------------------------------------------------------
    // Storage
    // ---------------------------------------------------------------------

    // partyKey = keccak256(countryCode ++ partyId)  =>  Party
    mapping(bytes32 => Party) private parties;
    bytes32[] private partyKeys;

    // legal-entity key => partyKey (enforces 1 entity : 1 party)
    mapping(address => bytes32) public entityToParty;

    // governance membership (the multisig signer set)
    mapping(address => bool) public isMember;
    address[] private members;
    uint256 public threshold;

    // Regulator read-only observer key
    address public auditor;

    // multisig proposals
    Proposal[] private proposals;
    mapping(uint256 => mapping(address => bool)) public confirmedBy;

    // ---------------------------------------------------------------------
    // Events  (consumed by the off-chain audit indexer and by each operator's
    //          node-permissioning sidecar that projects nodes-allowlist)
    // ---------------------------------------------------------------------

    event ProposalCreated(uint256 indexed id, ActionType indexed action, address indexed proposer);
    event Confirmed(uint256 indexed id, address indexed member, uint32 confirmations);
    event ConfirmationRevoked(uint256 indexed id, address indexed member, uint32 confirmations);
    event Executed(uint256 indexed id, ActionType indexed action);

    event PartyAdmitted(bytes32 indexed partyKey, bytes2 countryCode, bytes3 partyId, Role role, address indexed entity);
    event PartyRevoked(bytes32 indexed partyKey, address indexed entity);
    event PartyReinstated(bytes32 indexed partyKey, address indexed entity);
    event EndpointRotated(bytes32 indexed partyKey, address indexed entity);
    event PubKeyRotated(bytes32 indexed partyKey, address indexed entity);

    event MemberAdded(address indexed member);
    event MemberRemoved(address indexed member);
    event ThresholdChanged(uint256 newThreshold);
    event AuditorTransferred(address indexed previousAuditor, address indexed newAuditor);

    event ComplianceProbe(address indexed auditor, bytes32 indexed partyKey, string note, uint64 timestamp);

    // ---------------------------------------------------------------------
    // Modifiers
    // ---------------------------------------------------------------------

    modifier onlyMember() {
        require(isMember[msg.sender], "ADERA: caller is not a governance member");
        _;
    }

    modifier onlyAuditor() {
        require(msg.sender == auditor, "ADERA: caller is not the regulator's auditor");
        _;
    }

    // ---------------------------------------------------------------------
    // Constructor  (genesis trust anchor — founding parties bypass the vote)
    // ---------------------------------------------------------------------

    constructor(FoundingParty[] memory founders, uint256 threshold_, address auditor_) {
        require(founders.length > 0, "ADERA: no founding parties");
        require(auditor_ != address(0), "ADERA: auditor is zero address");
        require(threshold_ >= 1 && threshold_ <= founders.length, "ADERA: bad threshold");

        for (uint256 i = 0; i < founders.length; i++) {
            FoundingParty memory f = founders[i];
            bytes32 key = _registerParty(
                f.countryCode, f.partyId, f.role, f.entity, f.endpointCipher, f.pubKey
            );
            _addMember(f.entity);
            // founding parties are active from genesis
            parties[key].active = true;
        }

        threshold = threshold_;
        emit ThresholdChanged(threshold_);

        auditor = auditor_;
        emit AuditorTransferred(address(0), auditor_);
    }

    // ---------------------------------------------------------------------
    // Multisig core
    // ---------------------------------------------------------------------

    /// @notice Create a governance proposal. The proposer implicitly confirms it.
    ///         If the threshold is 1 the proposal executes atomically.
    function propose(ActionType action, bytes memory payload) public onlyMember returns (uint256 id) {
        id = proposals.length;
        proposals.push(Proposal({
            action: action,
            payload: payload,
            proposer: msg.sender,
            createdAt: uint64(block.timestamp),
            confirmations: 0,
            executed: false,
            cancelled: false
        }));
        emit ProposalCreated(id, action, msg.sender);
        _confirm(id, msg.sender);
    }

    /// @notice Confirm an existing proposal. Executes it once the threshold is met.
    function confirm(uint256 id) external onlyMember {
        _confirm(id, msg.sender);
    }

    /// @notice Withdraw a prior confirmation (only before execution).
    function revokeConfirmation(uint256 id) external onlyMember {
        Proposal storage p = proposals[id];
        require(!p.executed && !p.cancelled, "ADERA: proposal closed");
        require(confirmedBy[id][msg.sender], "ADERA: not confirmed by caller");
        confirmedBy[id][msg.sender] = false;
        p.confirmations -= 1;
        emit ConfirmationRevoked(id, msg.sender, p.confirmations);
    }

    function _confirm(uint256 id, address member) internal {
        Proposal storage p = proposals[id];
        require(!p.executed && !p.cancelled, "ADERA: proposal closed");
        require(!confirmedBy[id][member], "ADERA: already confirmed");
        confirmedBy[id][member] = true;
        p.confirmations += 1;
        emit Confirmed(id, member, p.confirmations);
        if (p.confirmations >= threshold) {
            _execute(id);
        }
    }

    function _execute(uint256 id) internal {
        Proposal storage p = proposals[id];
        require(!p.executed && !p.cancelled, "ADERA: proposal closed");
        p.executed = true;

        if (p.action == ActionType.AdmitParty) {
            (
                bytes2 cc, bytes3 pid, uint8 roleRaw, address entity,
                bytes memory endpointCipher, bytes memory pubKey
            ) = abi.decode(p.payload, (bytes2, bytes3, uint8, address, bytes, bytes));
            Role role = Role(roleRaw);
            bytes32 key = _registerParty(cc, pid, role, entity, endpointCipher, pubKey);
            parties[key].active = true;
            _addMember(entity);

        } else if (p.action == ActionType.RevokeParty) {
            bytes32 key = abi.decode(p.payload, (bytes32));
            Party storage party = parties[key];
            require(party.exists, "ADERA: unknown party");
            party.active = false;
            party.updatedAt = uint64(block.timestamp);
            _removeMember(party.entity);
            emit PartyRevoked(key, party.entity);

        } else if (p.action == ActionType.ReinstateParty) {
            bytes32 key = abi.decode(p.payload, (bytes32));
            Party storage party = parties[key];
            require(party.exists, "ADERA: unknown party");
            party.active = true;
            party.updatedAt = uint64(block.timestamp);
            _addMember(party.entity);
            emit PartyReinstated(key, party.entity);

        } else if (p.action == ActionType.AddMember) {
            address m = abi.decode(p.payload, (address));
            _addMember(m);

        } else if (p.action == ActionType.RemoveMember) {
            address m = abi.decode(p.payload, (address));
            _removeMember(m);
            require(members.length >= threshold, "ADERA: threshold would exceed members");

        } else if (p.action == ActionType.SetThreshold) {
            uint256 t = abi.decode(p.payload, (uint256));
            require(t >= 1 && t <= members.length, "ADERA: bad threshold");
            threshold = t;
            emit ThresholdChanged(t);

        } else if (p.action == ActionType.TransferAuditor) {
            address newAuditor = abi.decode(p.payload, (address));
            require(newAuditor != address(0), "ADERA: auditor is zero address");
            emit AuditorTransferred(auditor, newAuditor);
            auditor = newAuditor;

        } else {
            revert("ADERA: unknown action");
        }

        emit Executed(id, p.action);
    }

    // ---------------------------------------------------------------------
    // Ergonomic proposal wrappers (encode payload for callers / the deployer)
    // ---------------------------------------------------------------------

    function proposeAdmitParty(
        bytes2 countryCode,
        bytes3 partyId,
        Role role,
        address entity,
        bytes calldata endpointCipher,
        bytes calldata pubKey
    ) external onlyMember returns (uint256) {
        require(role != Role.None, "ADERA: role is None");
        require(entity != address(0), "ADERA: entity is zero address");
        return propose(
            ActionType.AdmitParty,
            abi.encode(countryCode, partyId, uint8(role), entity, endpointCipher, pubKey)
        );
    }

    function proposeRevokeParty(bytes32 partyKey) external onlyMember returns (uint256) {
        return propose(ActionType.RevokeParty, abi.encode(partyKey));
    }

    function proposeReinstateParty(bytes32 partyKey) external onlyMember returns (uint256) {
        return propose(ActionType.ReinstateParty, abi.encode(partyKey));
    }

    function proposeAddMember(address member) external onlyMember returns (uint256) {
        return propose(ActionType.AddMember, abi.encode(member));
    }

    function proposeRemoveMember(address member) external onlyMember returns (uint256) {
        return propose(ActionType.RemoveMember, abi.encode(member));
    }

    function proposeSetThreshold(uint256 newThreshold) external onlyMember returns (uint256) {
        return propose(ActionType.SetThreshold, abi.encode(newThreshold));
    }

    function proposeTransferAuditor(address newAuditor) external onlyMember returns (uint256) {
        return propose(ActionType.TransferAuditor, abi.encode(newAuditor));
    }

    // ---------------------------------------------------------------------
    // Self-service (only the party's own bound entity key)
    // ---------------------------------------------------------------------

    /// @notice Rotate your own encrypted OCPI endpoint. No vote required: an
    ///         operator controls where its own gateway lives. The identity
    ///         binding (entity <-> partyId) is untouched.
    function rotateEndpoint(bytes32 partyKey, bytes calldata newEndpointCipher) external {
        Party storage party = parties[partyKey];
        require(party.exists, "ADERA: unknown party");
        require(msg.sender == party.entity, "ADERA: caller is not the bound entity");
        party.endpointCipher = newEndpointCipher;
        party.updatedAt = uint64(block.timestamp);
        emit EndpointRotated(partyKey, msg.sender);
    }

    /// @notice Rotate your own messaging public key. Logged prominently so the
    ///         regulator's audit indexer can flag key-rotation events.
    function rotatePubKey(bytes32 partyKey, bytes calldata newPubKey) external {
        Party storage party = parties[partyKey];
        require(party.exists, "ADERA: unknown party");
        require(msg.sender == party.entity, "ADERA: caller is not the bound entity");
        party.pubKey = newPubKey;
        party.updatedAt = uint64(block.timestamp);
        emit PubKeyRotated(partyKey, msg.sender);
    }

    // ---------------------------------------------------------------------
    // Regulator auditor
    // ---------------------------------------------------------------------

    /// @notice Emit an on-chain attestation that the regulator inspected a party. This
    ///         is the auditor's ONLY state-touching capability and it mutates
    ///         no registry data — it only writes to the immutable event log.
    function auditProbe(bytes32 partyKey, string calldata note) external onlyAuditor {
        require(parties[partyKey].exists, "ADERA: unknown party");
        emit ComplianceProbe(msg.sender, partyKey, note, uint64(block.timestamp));
    }

    // ---------------------------------------------------------------------
    // Internal registry helpers
    // ---------------------------------------------------------------------

    function _registerParty(
        bytes2 countryCode,
        bytes3 partyId,
        Role role,
        address entity,
        bytes memory endpointCipher,
        bytes memory pubKey
    ) internal returns (bytes32 key) {
        require(role != Role.None, "ADERA: role is None");
        require(entity != address(0), "ADERA: entity is zero address");
        require(countryCode != bytes2(0), "ADERA: empty country code");
        require(partyId != bytes3(0), "ADERA: empty party id");

        key = computePartyKey(countryCode, partyId);
        require(!parties[key].exists, "ADERA: party id already registered");
        require(entityToParty[entity] == bytes32(0), "ADERA: entity already bound");

        parties[key] = Party({
            countryCode: countryCode,
            partyId: partyId,
            role: role,
            entity: entity,
            endpointCipher: endpointCipher,
            pubKey: pubKey,
            active: false,
            admittedAt: uint64(block.timestamp),
            updatedAt: uint64(block.timestamp),
            exists: true
        });
        partyKeys.push(key);
        entityToParty[entity] = key;

        emit PartyAdmitted(key, countryCode, partyId, role, entity);
    }

    function _addMember(address member) internal {
        require(member != address(0), "ADERA: member is zero address");
        if (!isMember[member]) {
            isMember[member] = true;
            members.push(member);
            emit MemberAdded(member);
        }
    }

    function _removeMember(address member) internal {
        if (isMember[member]) {
            isMember[member] = false;
            uint256 n = members.length;
            for (uint256 i = 0; i < n; i++) {
                if (members[i] == member) {
                    members[i] = members[n - 1];
                    members.pop();
                    break;
                }
            }
            emit MemberRemoved(member);
        }
    }

    // ---------------------------------------------------------------------
    // Views  (open to everyone — the directory is transparent by design)
    // ---------------------------------------------------------------------

    function computePartyKey(bytes2 countryCode, bytes3 partyId) public pure returns (bytes32) {
        return keccak256(abi.encodePacked(countryCode, partyId));
    }

    function getParty(bytes32 partyKey) external view returns (Party memory) {
        require(parties[partyKey].exists, "ADERA: unknown party");
        return parties[partyKey];
    }

    function getPartyByCode(bytes2 countryCode, bytes3 partyId) external view returns (Party memory) {
        bytes32 key = computePartyKey(countryCode, partyId);
        require(parties[key].exists, "ADERA: unknown party");
        return parties[key];
    }

    /// @notice Primary discovery call used by operator gateways.
    /// @return endpointCipher opaque encrypted OCPI endpoint blob
    /// @return pubKey         party messaging public key for handshake auth
    /// @return role           CPO / EMSP / HUB
    /// @return active         whether the party is currently permitted to roam
    function resolveEndpoint(bytes32 partyKey)
        external
        view
        returns (bytes memory endpointCipher, bytes memory pubKey, Role role, bool active)
    {
        Party storage p = parties[partyKey];
        require(p.exists, "ADERA: unknown party");
        return (p.endpointCipher, p.pubKey, p.role, p.active);
    }

    function isActiveParty(bytes2 countryCode, bytes3 partyId) external view returns (bool) {
        bytes32 key = computePartyKey(countryCode, partyId);
        return parties[key].exists && parties[key].active;
    }

    function partyCount() external view returns (uint256) {
        return partyKeys.length;
    }

    function partyKeyAt(uint256 index) external view returns (bytes32) {
        require(index < partyKeys.length, "ADERA: index out of range");
        return partyKeys[index];
    }

    function getAllPartyKeys() external view returns (bytes32[] memory) {
        return partyKeys;
    }

    function memberCount() external view returns (uint256) {
        return members.length;
    }

    function getMembers() external view returns (address[] memory) {
        return members;
    }

    function proposalCount() external view returns (uint256) {
        return proposals.length;
    }

    function getProposal(uint256 id)
        external
        view
        returns (
            ActionType action,
            bytes memory payload,
            address proposer,
            uint64 createdAt,
            uint32 confirmations,
            bool executed,
            bool cancelled
        )
    {
        require(id < proposals.length, "ADERA: unknown proposal");
        Proposal storage p = proposals[id];
        return (p.action, p.payload, p.proposer, p.createdAt, p.confirmations, p.executed, p.cancelled);
    }
}
