// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract MLMReferral {
    address public admin;
    IERC20 public usdt;

    uint256 public constant JOIN_AMOUNT = 10 * 1e18; // 10 USDT

    mapping(address => address) public parentOf;               // user => direct parent
    mapping(address => address[]) public childrenOf;           // user => direct children
    mapping(address => uint256) public directEarnings;         // user => total direct earnings
    mapping(address => uint256) public indirectEarnings;       // user => total indirect earnings
    mapping(address => bool) public hasJoined;                 // user => joined flag
    mapping(address => string) public referralCodes;           // user => their referral code
    mapping(string => address) public addressByCode;           // referral code => user

    // Events
    event UserJoined(address indexed user, address indexed parent, string referralCode);
    event DirectEarning(address indexed user, uint256 amount);
    event IndirectEarning(address indexed user, uint256 amount);
    event EarningsWithdrawn(address indexed user);
    event AdminDeposited(address indexed admin, uint256 amount);

    modifier onlyAdmin() {
        require(msg.sender == admin, "Only admin");
        _;
    }

    constructor(address _usdtTokenAddress) {
        admin = msg.sender;
        usdt = IERC20(_usdtTokenAddress);

        // Mark admin as joined
        hasJoined[admin] = true;

        // Generate and store referral code for admin
        string memory code = _generateReferralCode(admin);
        referralCodes[admin] = code;
        addressByCode[code] = admin;
    }

    function joinProgram(string calldata _referralCode) external {
        require(!hasJoined[msg.sender], "Already joined");

        address parent;
        if (bytes(_referralCode).length == 0) {
            parent = admin;
        } else {
            parent = addressByCode[_referralCode];
            require(parent != address(0), "Invalid referral code");
        }

        require(parent != msg.sender, "Cannot refer yourself");
        require(hasJoined[parent], "Parent has not joined");

        require(usdt.transferFrom(msg.sender, address(this), JOIN_AMOUNT), "USDT transfer failed");

        hasJoined[msg.sender] = true;
        parentOf[msg.sender] = parent;
        childrenOf[parent].push(msg.sender);

        // Direct earning: 2 USDT to parent
        uint256 directAmount = 2 * 1e18;
        directEarnings[parent] += directAmount;
        emit DirectEarning(parent, directAmount);

        // Ancestors for indirect earning (excluding parent)
        address[100] memory ancestors;
        uint256 count = 0;
        address current = parentOf[parent];

        while (current != address(0) && count < 100) {
            ancestors[count] = current;
            count++;
            current = parentOf[current];
        }

        // 1 USDT split among ancestors
        if (count > 0) {
            uint256 totalIndirect = 1 * 1e18;
            uint256 share = totalIndirect / count;

            for (uint256 i = 0; i < count; i++) {
                indirectEarnings[ancestors[i]] += share;
                emit IndirectEarning(ancestors[i], share);
            }
        }

        // Generate and assign referral code
        string memory code = _generateReferralCode(msg.sender);
        referralCodes[msg.sender] = code;
        addressByCode[code] = msg.sender;

        emit UserJoined(msg.sender, parent, code);
    }

    function withdrawEarnings() external {
        require(hasJoined[msg.sender], "Not joined");

        // Check if direct children count is divisible by 10
        uint256 directCount = childrenOf[msg.sender].length;
        require(directCount > 10, "Need at least 10 direct referrals to withdraw");

        uint256 totalEarnings = directEarnings[msg.sender] + indirectEarnings[msg.sender];
        require(totalEarnings > 0, "No earnings to withdraw");

        // Reset earnings to zero
        directEarnings[msg.sender] = 0;
        indirectEarnings[msg.sender] = 0;

        // Transfer USDT to user
        require(usdt.transfer(msg.sender, totalEarnings), "USDT transfer failed");
        emit EarningsWithdrawn(msg.sender);
    }

    function _generateReferralCode(address user) internal view returns (string memory) {
        bytes20 addr = bytes20(user);
        bytes memory alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
        bytes memory code = new bytes(6);

        for (uint256 i = 0; i < 6; i++) {
            code[i] = alphabet[uint8(addr[i]) % alphabet.length];
        }

        string memory referralCode = string(code);
        uint256 nonce = 0;

        while (addressByCode[referralCode] != address(0)) {
            code[5] = alphabet[(uint8(addr[5]) + nonce) % alphabet.length];
            referralCode = string(code);
            nonce++;
        }

        return referralCode;
    }

    // Public view helpers
    function getDirectEarnings(address user) external view returns (uint256) {
        return directEarnings[user];
    }

    function getIndirectEarnings(address user) external view returns (uint256) {
        return indirectEarnings[user];
    }

    function getChildren(address user) external view returns (address[] memory) {
        return childrenOf[user];
    }

    // Admin-only withdrawal
    function withdrawAdminFunds(address to, uint256 amount) external onlyAdmin {
        require(usdt.transfer(to, amount), "Withdraw failed");
    }

    // Admin-only deposit function
    function depositUSDT(uint256 amount) external onlyAdmin {
        require(usdt.transferFrom(msg.sender, address(this), amount), "USDT transfer failed");
        emit AdminDeposited(msg.sender, amount);
    }
}
