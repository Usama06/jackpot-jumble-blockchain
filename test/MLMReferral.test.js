const {expectRevert} = require('@openzeppelin/test-helpers');
const {assert} = require('chai');

const MLMReferral = artifacts.require("MLMReferral");
const MockUSDT = artifacts.require("MockUSDT");

const JOIN_AMOUNT = web3.utils.toWei("10", "ether");

contract("MLMReferral", (accounts) => {
    let usdt, mlm;

    const admin = accounts[0];
    const user1 = accounts[1];
    const user2 = accounts[2];
    const user3 = accounts[3];
    const user4 = accounts[4];
    const user5 = accounts[5];

    const JOIN_AMOUNT = web3.utils.toWei("10", "ether");

    beforeEach(async () => {
        usdt = await MockUSDT.new();
        mlm = await MLMReferral.new(usdt.address);

        const users = [user1, user2, user3, user4, user5];
        for (let user of users) {
            await usdt.transfer(user, JOIN_AMOUNT, {from: admin});
            await usdt.approve(mlm.address, JOIN_AMOUNT, {from: user});
        }

        await usdt.approve(mlm.address, JOIN_AMOUNT, {from: admin});
    });

    it("should deploy correctly and mark admin as joined", async () => {
        const isAdminJoined = await mlm.hasJoined(admin);
        expect(isAdminJoined).to.be.true;

        const adminCode = await mlm.referralCodes(admin);
        expect(adminCode.length).to.equal(6);
    });

    it("should allow user to join without referral code (defaults to admin)", async () => {
        await mlm.joinProgram("", {from: user1});

        const isJoined = await mlm.hasJoined(user1);
        expect(isJoined).to.be.true;

        const parent = await mlm.parentOf(user1);
        expect(parent).to.equal(admin);
    });

    it("should allow user to join with valid referral code", async () => {
        await mlm.joinProgram("", {from: user1});
        const code = await mlm.referralCodes(user1);

        await mlm.joinProgram(code, {from: user2});

        const parent = await mlm.parentOf(user2);
        expect(parent).to.equal(user1);
    });

    it("should assign a unique referral code to each user", async () => {
        await mlm.joinProgram("", {from: user1});
        await mlm.joinProgram("", {from: user2});

        const code1 = await mlm.referralCodes(user1);
        const code2 = await mlm.referralCodes(user2);

        expect(code1).to.not.equal(code2);
    });

    it("should distribute earnings correctly through levels", async () => {
        const [admin, userA, userB, userC, userD] = accounts;

        const adminReferralCode = await mlm.referralCodes(admin);

        // A joins with admin's code
        await usdt.transfer(userA, JOIN_AMOUNT, {from: admin});
        await usdt.approve(mlm.address, JOIN_AMOUNT, {from: userA});
        await mlm.joinProgram(adminReferralCode, {from: userA});

        const referralCodeA = await mlm.referralCodes(userA);

        // B joins with A's code
        await usdt.transfer(userB, JOIN_AMOUNT, {from: admin});
        await usdt.approve(mlm.address, JOIN_AMOUNT, {from: userB});
        await mlm.joinProgram(referralCodeA, {from: userB});

        const referralCodeB = await mlm.referralCodes(userB);

        // C joins with B's code
        await usdt.transfer(userC, JOIN_AMOUNT, {from: admin});
        await usdt.approve(mlm.address, JOIN_AMOUNT, {from: userC});
        await mlm.joinProgram(referralCodeB, {from: userC});

        const referralCodeC = await mlm.referralCodes(userC);

        // D joins with C's code
        await usdt.transfer(userD, JOIN_AMOUNT, {from: admin});
        await usdt.approve(mlm.address, JOIN_AMOUNT, {from: userD});
        await mlm.joinProgram(referralCodeC, {from: userD});

        // Verify earnings
        const earningsC = await mlm.getDirectEarnings(userC);
        const earningsA = await mlm.getIndirectEarnings(userA);
        const earningsAdmin = await mlm.getIndirectEarnings(admin);

        assert.equal(earningsC.toString(), web3.utils.toWei("2", "ether"), "C should get 2 USDT");
        // 0.5 from C's join + 0.333... from D's join
        assert.equal(
            earningsA.toString(),
            "833333333333333333",
            "A should get approx 0.833... USDT"
        );

// 1 from B's join + 0.5 from C + 0.333... from D
        assert.equal(
            earningsAdmin.toString(),
            "1833333333333333333",
            "Admin should get approx 1.833... USDT"
        );
    });


    it("should fail with invalid referral code", async () => {
        try {
            await mlm.joinProgram("INVALID", {from: user1});
            expect.fail("Expected error not thrown");
        } catch (err) {
            expect(err.reason).to.equal("Invalid referral code");
        }
    });

    it("should not allow joining twice", async () => {
        await mlm.joinProgram("", {from: user1});

        try {
            await mlm.joinProgram("", {from: user1});
            expect.fail("Expected error not thrown");
        } catch (err) {
            expect(err.reason).to.equal("Already joined");
        }
    });

    it("should return children correctly", async () => {
        await mlm.joinProgram("", {from: user1});
        const code = await mlm.referralCodes(user1);
        await mlm.joinProgram(code, {from: user2});
        await mlm.joinProgram(code, {from: user3});

        const children = await mlm.getChildren(user1);
        expect(children.length).to.equal(2);
        expect(children).to.include.members([user2, user3]);
    });

    it("should allow admin to withdraw", async () => {
        const [admin, userA] = accounts;

        const adminReferralCode = await mlm.referralCodes(admin);

        await usdt.transfer(userA, JOIN_AMOUNT, {from: admin});
        await usdt.approve(mlm.address, JOIN_AMOUNT, {from: userA});
        await mlm.joinProgram(adminReferralCode, {from: userA});

        const contractBalance = await usdt.balanceOf(mlm.address);
        const adminBalanceBefore = await usdt.balanceOf(admin);

        await mlm.withdrawAdminFunds(admin, contractBalance, {from: admin});

        const adminBalanceAfter = await usdt.balanceOf(admin);

        assert.isTrue(
            adminBalanceAfter.gt(adminBalanceBefore),
            "Admin balance should increase after withdrawal"
        );
    });

    it("should allow eligible user to withdraw earnings when direct referrals are greater than 10", async () => {
        const eligibleUser = user1;

        await mlm.joinProgram("", {from: eligibleUser});

        // Generate referral code for eligibleUser
        const userCode = await mlm.referralCodes(eligibleUser);

        // Create 11 direct children (greater than 10)
        for (let i = 0; i < 11; i++) {
            const newUser = accounts[6 + i];
            await usdt.transfer(newUser, JOIN_AMOUNT, {from: admin});
            await usdt.approve(mlm.address, JOIN_AMOUNT, {from: newUser});
            await mlm.joinProgram(userCode, {from: newUser});
        }

        // Verify direct children count
        const children = await mlm.getChildren(eligibleUser);
        assert.equal(children.length, 11, "User should have 11 direct children");

        // Record earnings
        const directEarnings = await mlm.getDirectEarnings(eligibleUser);
        const indirectEarnings = await mlm.getIndirectEarnings(eligibleUser);
        const totalEarnings = directEarnings.add(indirectEarnings);

        // Record balance before withdrawal
        const balanceBefore = await usdt.balanceOf(eligibleUser);

        // Withdraw earnings
        await mlm.withdrawEarnings({from: eligibleUser});

        // Verify user balance increased
        const balanceAfter = await usdt.balanceOf(eligibleUser);
        assert.equal(
            balanceAfter.sub(balanceBefore).toString(),
            totalEarnings.toString(),
            "User balance should increase by total earnings"
        );

        // Verify earnings reset to zero
        const directEarningsAfter = await mlm.getDirectEarnings(eligibleUser);
        const indirectEarningsAfter = await mlm.getIndirectEarnings(eligibleUser);
        assert.equal(directEarningsAfter.toString(), "0", "Direct earnings should reset");
        assert.equal(indirectEarningsAfter.toString(), "0", "Indirect earnings should reset");
    });

    it("should not allow user to withdraw earnings if direct referrals are 10 or less", async () => {
        const ineligibleUser = user2;

        await mlm.joinProgram("", {from: ineligibleUser});

        // Generate referral code
        const userCode = await mlm.referralCodes(ineligibleUser);

        // Create exactly 10 direct children (not eligible, as must be >10)
        for (let i = 0; i < 10; i++) {
            const newUser = accounts[6 + i];
            await usdt.transfer(newUser, JOIN_AMOUNT, {from: admin});
            await usdt.approve(mlm.address, JOIN_AMOUNT, {from: newUser});
            await mlm.joinProgram(userCode, {from: newUser});
        }

        // Attempt to withdraw, should revert
        await expectRevert(
            mlm.withdrawEarnings({from: ineligibleUser}),
            "Need at least 10 direct referrals to withdraw"
        );
    });

    it("should allow only admin to deposit USDT and emit event", async () => {
        const depositAmount = web3.utils.toWei("100", "ether");

        // Admin deposits USDT
        const receipt = await mlm.depositUSDT(depositAmount, {from: admin});

        // Check contract balance
        const contractBalance = await usdt.balanceOf(mlm.address);
        assert.equal(contractBalance.toString(), depositAmount, "Contract balance should increase");

        // Check event emission
        const event = receipt.logs.find(log => log.event === "AdminDeposited");
        assert.isDefined(event, "AdminDeposited event should be emitted");
        assert.equal(event.args.admin, admin, "Event admin should match");
        assert.equal(event.args.amount.toString(), depositAmount, "Event amount should match");
    });

    it("should not allow non-admin to deposit USDT", async () => {
        const depositAmount = web3.utils.toWei("10", "ether");
        await expectRevert(
            mlm.depositUSDT(depositAmount, {from: user1}),
            "Only admin can call this function"
        );
    });
});
