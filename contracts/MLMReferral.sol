// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/security/ReentrancyGuard.sol";

/// @title MLMReferral (production-optimized, 6-char alphanumeric codes with passcode protection)
contract MLMReferral is ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ─────────── Errors ───────────
    error OnlyAdmin();
    error InvalidPasscode();
    error AlreadyJoined();
    error InvalidReferralCode();
    error SelfReferral();
    error ParentNotJoined();
    error NotJoined();
    error NeedAtLeast10Directs();
    error NothingToWithdraw();
    error AmountExceedsCommission();
    error RecoverMainTokenForbidden();

    // ─────────── Constants / Immutables ───────────
    uint256 private constant MAX_DEPTH = 10;

    address public immutable admin;
    IERC20 public immutable token;
    uint8 public immutable tokenDecimals;
    uint256 public immutable SCALE;

    uint256 public immutable JOIN_AMOUNT;     // 10 * SCALE
    uint256 public immutable DIRECT_REWARD;   // 2  * SCALE
    uint256 public immutable INDIRECT_TOTAL;  // 1  * SCALE
    uint256 public immutable ADMIN_REWARD;    // 7  * SCALE

    // Passcode hash - stored as keccak256 hash, original is never stored
    bytes32 private immutable passcodeHash;

    // ─────────── Storage ───────────
    uint256 public adminCommission;

    mapping(address => address) public parentOf;          // user => direct parent
    mapping(address => address[]) private _childrenOf;    // user => direct children
    mapping(address => uint256) public directEarnings;
    mapping(address => uint256) public indirectEarnings;
    mapping(address => bool)    public hasJoined;

    // Referral codes: fixed 6 ASCII chars (A-Z,0-9) packed in bytes6
    mapping(address => bytes6)  public referralCodes;     // user => code
    mapping(bytes6 => address)  public addressByCode;     // code => user

    // ─────────── Events ───────────
    event UserJoined(address indexed user, address indexed parent, bytes6 referralCode);
    event DirectEarning(address indexed user, uint256 amount);
    event IndirectEarning(address indexed user, uint256 amount);
    event EarningsWithdrawn(address indexed user, uint256 amount);
    event AdminWithdrawn(address indexed to, uint256 amount);
    event ERC20Recovered(address indexed erc20, address indexed to, uint256 amount);

    // ─────────── Modifiers ───────────
    modifier onlyAdminWithPasscode(string memory passcode) {
        if (msg.sender != admin) revert OnlyAdmin();
        if (keccak256(abi.encodePacked(passcode)) != passcodeHash) revert InvalidPasscode();
        _;
    }

    // ─────────── Constructor ───────────
    constructor(address _token, string memory _passcode) {
        admin = msg.sender;
        token = IERC20(_token);

        // Hash and store the passcode - original is never stored
        passcodeHash = keccak256(abi.encodePacked(_passcode));

        uint8 dec = IERC20Metadata(_token).decimals();
        tokenDecimals = dec;
        uint256 scale = 10 ** dec;
        SCALE = scale;

        JOIN_AMOUNT = 10 * scale;
        DIRECT_REWARD = 2 * scale;
        INDIRECT_TOTAL = 1 * scale;
        ADMIN_REWARD = 7 * scale;

        hasJoined[admin] = true;

        bytes6 code = _uniqueCodeFor(admin);
        referralCodes[admin] = code;
        addressByCode[code] = admin;
    }

    // ─────────── Public Views ───────────
    function getChildren(address user) external view returns (address[] memory) {
        return _childrenOf[user];
    }

    function directChildrenCount(address user) external view returns (uint256) {
        return _childrenOf[user].length;
    }

    /// @notice Human-readable referral code for a user (e.g., "AB12CD")
    function referralCodeStringOf(address user) external view returns (string memory) {
        return _toCodeString(referralCodes[user]);
    }

    // ─────────── Core: Join ───────────
    /// @param refCode 6-char alphanumeric code (bytes6). Pass 0x000000000000 to default to admin.
    function joinProgram(bytes6 refCode) external nonReentrant {
        if (hasJoined[msg.sender]) revert AlreadyJoined();

        address parent = refCode == bytes6(0) ? admin : addressByCode[refCode];
        if (parent == address(0)) revert InvalidReferralCode();
        if (parent == msg.sender) revert SelfReferral();
        if (!hasJoined[parent]) revert ParentNotJoined();

        token.safeTransferFrom(msg.sender, address(this), JOIN_AMOUNT);

        hasJoined[msg.sender] = true;
        parentOf[msg.sender] = parent;
        _childrenOf[parent].push(msg.sender);

        unchecked {
            directEarnings[parent] += DIRECT_REWARD;
        }
        emit DirectEarning(parent, DIRECT_REWARD);

        // Indirect split among up to 10 ancestors (excluding parent)
        address current = parentOf[parent];
        address[MAX_DEPTH] memory ancestors;
        uint256 n;

        while (current != address(0) && n < MAX_DEPTH) {
            ancestors[n] = current;
            unchecked {n++;}
            current = parentOf[current];
        }

        if (n == 0) {
            unchecked {adminCommission += INDIRECT_TOTAL;}
        } else {
            uint256 share = INDIRECT_TOTAL / n;
            uint256 remainder = INDIRECT_TOTAL - (share * n);
            for (uint256 i = 0; i < n;) {
                unchecked {
                    indirectEarnings[ancestors[i]] += share;
                    i++;
                }
                emit IndirectEarning(ancestors[i - 1], share);
            }
            if (remainder != 0) {
                unchecked {directEarnings[parent] += remainder;}
                emit DirectEarning(parent, remainder);
            }
        }

        unchecked {adminCommission += ADMIN_REWARD;}

        // Generate & assign a unique 6-char alphanumeric code
        bytes6 code = _uniqueCodeFor(msg.sender);
        referralCodes[msg.sender] = code;
        addressByCode[code] = msg.sender;

        emit UserJoined(msg.sender, parent, code);
    }

    // ─────────── Withdrawals ───────────
    /// @notice Users can withdraw once they have >= 10 direct referrals.
    function withdrawEarnings() external nonReentrant {
        if (!hasJoined[msg.sender]) revert NotJoined();
        if (_childrenOf[msg.sender].length < 10) revert NeedAtLeast10Directs();

        uint256 amount = directEarnings[msg.sender] + indirectEarnings[msg.sender];
        if (amount == 0) revert NothingToWithdraw();

        directEarnings[msg.sender] = 0;
        indirectEarnings[msg.sender] = 0;

        token.safeTransfer(msg.sender, amount);
        emit EarningsWithdrawn(msg.sender, amount);
    }

    /// @notice Admin can withdraw up to accumulated adminCommission (requires passcode).
    function withdrawAdminFunds(address to, uint256 amount, string memory passcode)
    external
    nonReentrant
    onlyAdminWithPasscode(passcode)
    {
        if (amount > adminCommission) revert AmountExceedsCommission();

        unchecked {adminCommission -= amount;}
        token.safeTransfer(to, amount);
        emit AdminWithdrawn(to, amount);
    }

    // ─────────── Admin: Recover non-main tokens ───────────
    function recoverERC20(address erc20, address to, uint256 amount, string memory passcode)
    external
    nonReentrant
    onlyAdminWithPasscode(passcode)
    {
        if (erc20 == address(token)) revert RecoverMainTokenForbidden();
        IERC20(erc20).safeTransfer(to, amount);
        emit ERC20Recovered(erc20, to, amount);
    }

    // ─────────── Internal: 6-char Alphanumeric Code Utils ───────────
    /// @dev Generates a unique 6-char code using keccak + nonce retry; chars are A–Z then 0–9.
    function _uniqueCodeFor(address user) internal view returns (bytes6) {
        uint256 nonce = 0;
        while (true) {
            bytes6 code = _genCodeTry(user, nonce);
            // zero is impossible with our alphabet, but keep the guard pattern
            if (code != bytes6(0) && addressByCode[code] == address(0)) {
                return code;
            }
            unchecked {nonce++;}
        }
        // This line should never be reached due to the infinite loop, but added for compiler satisfaction
        return bytes6(0);
    }

    function _genCodeTry(address user, uint256 nonce) internal pure returns (bytes6) {
        bytes32 h = keccak256(abi.encodePacked(user, nonce));
        uint48 packed; // 6 bytes
        // derive 6 chars from 6 distinct bytes of the hash
        for (uint256 i = 0; i < 6;) {
            uint8 v = uint8(h[i]) % 36; // 0..35
            bytes1 c = _alpha36(v);     // 'A'-'Z','0'-'9'
            packed = (packed << 8) | uint48(uint8(c));
            unchecked {i++;}
        }
        return bytes6(packed);
    }

    /// @dev Maps 0..35 to ASCII: 0..25 => 'A'..'Z', 26..35 => '0'..'9'
    function _alpha36(uint8 v) internal pure returns (bytes1) {
        unchecked {
            return v < 26 ? bytes1(uint8(65) + v) : bytes1(uint8(48) + (v - 26));
        }
    }

    function _toCodeString(bytes6 code) internal pure returns (string memory s) {
        s = new string(6);
        assembly {
            // string data pointer
            let p := add(s, 32)
            // write 6 bytes from code into string
            mstore8(p, byte(0, code))
            mstore8(add(p, 1), byte(1, code))
            mstore8(add(p, 2), byte(2, code))
            mstore8(add(p, 3), byte(3, code))
            mstore8(add(p, 4), byte(4, code))
            mstore8(add(p, 5), byte(5, code))
        }
    }
}
