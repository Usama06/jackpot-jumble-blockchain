/* eslint-disable no-undef */
const {expectRevert, time} = require("@openzeppelin/test-helpers");
const {assert, expect} = require("chai");

const MLMReferral = artifacts.require("MLMReferral");
const MockUSDT = artifacts.require("MockUSDT");

// --- helpers -------------------------------------------------

/** Convert 6-char ASCII (A-Z,0-9) to bytes6 hex ("ABC123" -> "0x414243313233") */
function bytes6FromAscii(str) {
    if (str.length !== 6) throw new Error("needs 6 chars");
    return "0x" + Buffer.from(str, "ascii").toString("hex");
}

/** Return SCALE = 10 ** decimals (BN) */
async function scaleOf(token) {
    const dec = await token.decimals();
    return web3.utils.toBN("10").pow(web3.utils.toBN(dec));
}

/** Return amount in token units: n * SCALE */
async function units(token, nString) {
    const scl = await scaleOf(token);
    return scl.mul(web3.utils.toBN(nString));
}

contract("MLMReferral (prod, bytes6 codes)", (accounts) => {
    const [admin, u1, u2, u3, u4, u5, ...rest] = accounts;

    let usdt, mlm;
    let SCALE, JOIN_AMOUNT, DIRECT_REWARD, INDIRECT_TOTAL, ADMIN_REWARD;

    beforeEach(async () => {
        usdt = await MockUSDT.new({from: admin}); // must implement decimals()
        mlm = await MLMReferral.new(usdt.address, {from: admin});

        SCALE = await scaleOf(usdt);
        JOIN_AMOUNT = SCALE.muln(10);
        DIRECT_REWARD = SCALE.muln(2);
        INDIRECT_TOTAL = SCALE.muln(1);
        ADMIN_REWARD = SCALE.muln(7);

        // Give everyone plenty of tokens and approve the contract
        const all = accounts.slice(0, 20);
        for (const a of all) {
            // If your MockUSDT doesn't mint to admin by default, mint or seed first.
            // Here we transfer from admin assuming initial supply at admin.
            await usdt.transfer(a, JOIN_AMOUNT.muln(100), {from: admin});
            await usdt.approve(mlm.address, JOIN_AMOUNT.muln(100), {from: a});
        }
    });

    // --------------------------------------------------------------------------
    // Deployment & admin bootstrap
    // --------------------------------------------------------------------------

    it("deploys, admin is joined, has 6-char code", async () => {
        const isAdminJoined = await mlm.hasJoined(admin);
        assert.isTrue(isAdminJoined, "admin should be marked joined");

        const adminCodeRaw = await mlm.referralCodes(admin);
        // bytes6 hex length = 2 + 12 = 14
        assert.equal(adminCodeRaw.length, 14, "raw bytes6 hex should be 14 chars");

        const adminCodeStr = await mlm.referralCodeStringOf(admin);
        assert.equal(adminCodeStr.length, 6, "string code should be 6 chars");
    });

    // --------------------------------------------------------------------------
    // Join (no code) -> parent = admin
    // --------------------------------------------------------------------------

    it("user can join without referral code (defaults to admin)", async () => {
        await mlm.joinProgram("0x000000000000", {from: u1});

        assert.isTrue(await mlm.hasJoined(u1), "u1 joined");
        assert.equal(await mlm.parentOf(u1), admin, "parent is admin");

        // Parent direct earnings +2
        const direct = await mlm.directEarnings(admin);
        assert.equal(direct.toString(), DIRECT_REWARD.toString(), "admin direct +2");

        // No ancestors => adminCommission gets +7 (admin) +1 (indirect) = +8
        const commission = await mlm.adminCommission();
        assert.equal(
            commission.toString(),
            ADMIN_REWARD.add(INDIRECT_TOTAL).toString(),
            "adminCommission +8"
        );
    });

    // --------------------------------------------------------------------------
    // Join with valid code (multi-level) & earnings distribution
    // --------------------------------------------------------------------------

    it("multi-level joins distribute direct/indirect correctly (dust -> parent, no-ancestor -> adminCommission)", async () => {
        // A joins using admin's code (parent=admin, no ancestors)
        const adminCode = await mlm.referralCodes(admin);
        await mlm.joinProgram(adminCode, {from: u1});

        // B joins using A's code (parent=A, ancestors=[admin])
        const codeA = await mlm.referralCodes(u1);
        await mlm.joinProgram(codeA, {from: u2});

        // C joins using B's code (parent=B, ancestors=[A, admin])
        const codeB = await mlm.referralCodes(u2);
        await mlm.joinProgram(codeB, {from: u3});

        // D joins using C's code (parent=C, ancestors=[B, A, admin])
        const codeC = await mlm.referralCodes(u3);
        await mlm.joinProgram(codeC, {from: u4});

        // After these joins, inspect:
        // Direct:
        // - On B join: A +2
        // - On C join: B +2
        // - On D join: C +2    (+ dust remainder from D's indirect split)
        //
        // Indirect splits:
        // - B's join: ancestors=[admin] -> admin +1
        // - C's join: ancestors=[A, admin] -> each gets floor(1/2) = 0.5 * SCALE
        // - D's join: ancestors=[B, A, admin] -> each gets floor(1/3) * SCALE; remainder = 1 - 3*floor(1/3)
        //   remainder goes to parent (C)

        // Direct earnings
        const directA = await mlm.directEarnings(u1);
        const directB = await mlm.directEarnings(u2);
        const directC = await mlm.directEarnings(u3);
        // Indirect earnings
        const indA = await mlm.indirectEarnings(u1);
        const indAdmin = await mlm.indirectEarnings(admin);

        // Check direct for B and C: exactly +2 each
        assert.equal(directB.toString(), DIRECT_REWARD.toString(), "B direct +2");
        assert.equal(directC.gte(DIRECT_REWARD), true, "C direct >= +2 (may include dust)");

        // A should have received indirect: 0.5 (from C) + floor(1/3) (from D)
        const half = SCALE.divn(2);
        const third = SCALE.divn(3);
        const expectedAIndirect = half.add(third);
        assert.equal(indA.toString(), expectedAIndirect.toString(), "A indirect 0.5 + 1/3");

        // Admin indirect: +1 (from B) + 0.5 (from C) + 1/3 (from D)
        const expectedAdminIndirect = SCALE.add(half).add(third);
        assert.equal(
            indAdmin.toString(),
            expectedAdminIndirect.toString(),
            "admin indirect 1 + 0.5 + 1/3"
        );

        // C's direct should be +2 plus any remainder dust from D's split (SCALE % 3)
        const remainder = SCALE.sub(third.muln(3)); // SCALE - 3*floor(SCALE/3)
        const expectedCMin = DIRECT_REWARD.add(remainder);
        assert.equal(directC.toString(), expectedCMin.toString(), "C direct +2 + dust remainder");

        // adminCommission should be:
        // A join: 7 + 1 (no ancestor) = +8
        // B join: +7 (has ancestors) = +7
        // C join: +7 (has ancestors) = +7
        // D join: +7 (has ancestors) = +7
        const expectedCommission = ADMIN_REWARD
            .add(INDIRECT_TOTAL) // +8 from A
            .add(ADMIN_REWARD)   // +7 from B
            .add(ADMIN_REWARD)   // +7 from C
            .add(ADMIN_REWARD);  // +7 from D
        const commission = await mlm.adminCommission();
        assert.equal(commission.toString(), expectedCommission.toString(), "adminCommission matches");
    });

    // --------------------------------------------------------------------------
    // Invalid referral code (bytes6 not mapped)
    // --------------------------------------------------------------------------

    it("reverts on invalid referral code", async () => {
        // random non-existent bytes6 like "ABC123"
        const invalid = bytes6FromAscii("ABC123");
        await expectRevert.unspecified(mlm.joinProgram(invalid, {from: u1}));
    });

    // --------------------------------------------------------------------------
    // Already joined
    // --------------------------------------------------------------------------

    it("reverts if user tries to join twice", async () => {
        await mlm.joinProgram("0x000000000000", {from: u1});
        await expectRevert.unspecified(mlm.joinProgram("0x000000000000", {from: u1}));
    });

    // --------------------------------------------------------------------------
    // Children getters
    // --------------------------------------------------------------------------

    it("returns children correctly & directChildrenCount()", async () => {
        await mlm.joinProgram("0x000000000000", {from: u1}); // parent admin
        const codeU1 = await mlm.referralCodes(u1);

        await mlm.joinProgram(codeU1, {from: u2});
        await mlm.joinProgram(codeU1, {from: u3});
        await mlm.joinProgram(codeU1, {from: u4});

        const kids = await mlm.getChildren(u1);
        expect(kids).to.have.members([u2, u3, u4]);

        const cnt = await mlm.directChildrenCount(u1);
        assert.equal(cnt.toString(), "3", "u1 has 3 directs");
    });

    // --------------------------------------------------------------------------
    // Admin withdraw limited by adminCommission
    // --------------------------------------------------------------------------

    it("admin can withdraw up to adminCommission (not full contract balance necessarily)", async () => {
        // One join under admin: commission should be +8 * SCALE
        const adminCode = await mlm.referralCodes(admin);
        await mlm.joinProgram(adminCode, {from: u1});

        const commission = await mlm.adminCommission();
        const before = await usdt.balanceOf(admin);

        await mlm.withdrawAdminFunds(admin, commission, {from: admin});

        const after = await usdt.balanceOf(admin);
        assert.equal(after.sub(before).toString(), commission.toString(), "admin got commission");

        // Withdrawing more should revert
        await expectRevert.unspecified(
            mlm.withdrawAdminFunds(admin, SCALE, {from: admin}) // any positive amount now > commission
        );
    });

    // --------------------------------------------------------------------------
    // User withdraw eligibility: >= 10 directs required
    // --------------------------------------------------------------------------

    it("user can withdraw with exactly 10 direct referrals (>= 10 rule)", async () => {
        await mlm.joinProgram("0x000000000000", {from: u1});
        const codeU1 = await mlm.referralCodes(u1);

        // Create exactly 10 direct referrals for u1
        for (let i = 0; i < 10; i++) {
            await mlm.joinProgram(codeU1, {from: rest[i]});
        }

        const count = await mlm.directChildrenCount(u1);
        assert.equal(count.toString(), "10", "u1 has exactly 10 directs");

        const due =
            (await mlm.directEarnings(u1)).add(await mlm.indirectEarnings(u1));

        const balBefore = await usdt.balanceOf(u1);
        await mlm.withdrawEarnings({from: u1});
        const balAfter = await usdt.balanceOf(u1);

        assert.equal(
            balAfter.sub(balBefore).toString(),
            due.toString(),
            "u1 received total earnings"
        );

        // earnings reset
        assert.equal((await mlm.directEarnings(u1)).toString(), "0");
        assert.equal((await mlm.indirectEarnings(u1)).toString(), "0");
    });

    it("reverts withdraw if user has < 10 directs", async () => {
        await mlm.joinProgram("0x000000000000", {from: u2});
        const codeU2 = await mlm.referralCodes(u2);

        // 9 direct referrals only
        for (let i = 0; i < 9; i++) {
            await mlm.joinProgram(codeU2, {from: rest[i]});
        }

        await expectRevert.unspecified(mlm.withdrawEarnings({from: u2}));
    });

    // --------------------------------------------------------------------------
    // Recover tokens: cannot recover main token, can recover other tokens
    // --------------------------------------------------------------------------

    it("cannot recover main token; can recover a different ERC20", async () => {
        // Seed the MLM contract with some OTHER token to test recovery
        const other = await MockUSDT.new({from: admin});
        const OTHER_SCALE = await scaleOf(other);
        const deposit = OTHER_SCALE.muln(123);

        await other.transfer(mlm.address, deposit, {from: admin});

        // Recover OTHER token
        const adminBalBeforeOther = await other.balanceOf(admin);
        await mlm.recoverERC20(other.address, admin, deposit, {from: admin});
        const adminBalAfterOther = await other.balanceOf(admin);

        assert.equal(
            adminBalAfterOther.sub(adminBalBeforeOther).toString(),
            deposit.toString(),
            "recovered other token"
        );

        // Attempt to recover MAIN token should revert
        await expectRevert.unspecified(
            mlm.recoverERC20(usdt.address, admin, SCALE, {from: admin})
        );
    });

    // --------------------------------------------------------------------------
    // Referral code properties: uniqueness & alphabet
    // --------------------------------------------------------------------------

    it("assigns unique 6-char alphanumeric codes; alphabet A-Z and 0-9 only", async () => {
        await mlm.joinProgram("0x000000000000", {from: u1});
        await mlm.joinProgram("0x000000000000", {from: u2});
        await mlm.joinProgram("0x000000000000", {from: u3});

        const s1 = await mlm.referralCodeStringOf(u1);
        const s2 = await mlm.referralCodeStringOf(u2);
        const s3 = await mlm.referralCodeStringOf(u3);

        // Uniqueness
        assert.notEqual(s1, s2);
        assert.notEqual(s1, s3);
        assert.notEqual(s2, s3);

        // Alphabet constraint
        const re = /^[A-Z0-9]{6}$/;
        assert.isTrue(re.test(s1), "s1 alphanumeric 6");
        assert.isTrue(re.test(s2), "s2 alphanumeric 6");
        assert.isTrue(re.test(s3), "s3 alphanumeric 6");
    });

    // --------------------------------------------------------------------------
    // Gas / CEI sanity: withdraw zero should revert
    // --------------------------------------------------------------------------

    it("reverts withdraw when earnings are zero", async () => {
        await mlm.joinProgram("0x000000000000", {from: u1});
        const codeU1 = await mlm.referralCodes(u1);

        // Make 10 directs so eligible, but then do a withdraw to zero out…
        for (let i = 0; i < 10; i++) {
            await mlm.joinProgram(codeU1, {from: rest[i]});
        }
        await mlm.withdrawEarnings({from: u1});

        // Next withdraw with zero balance should revert
        await expectRevert.unspecified(mlm.withdrawEarnings({from: u1}));
    });

    // --------------------------------------------------------------------------
    // Additional edge cases and error handling
    // --------------------------------------------------------------------------

    it("reverts if user tries to refer themselves", async () => {
        await mlm.joinProgram("0x000000000000", {from: u1});
        const codeU1 = await mlm.referralCodes(u1);
        
        // u1 tries to join using their own code
        await expectRevert.unspecified(mlm.joinProgram(codeU1, {from: u1}));
    });

    it("reverts if user tries to join with invalid referral code", async () => {
        // Create a fake code that doesn't exist
        const fakeCode = bytes6FromAscii("FAKE12");
        
        await expectRevert.unspecified(mlm.joinProgram(fakeCode, {from: u1}));
    });

    it("reverts if non-joined user tries to withdraw", async () => {
        await expectRevert.unspecified(mlm.withdrawEarnings({from: u1}));
    });

    it("reverts if non-admin tries to withdraw admin funds", async () => {
        await expectRevert.unspecified(
            mlm.withdrawAdminFunds(u1, SCALE, {from: u1})
        );
    });

    it("reverts if non-admin tries to recover ERC20", async () => {
        const other = await MockUSDT.new({from: admin});
        await expectRevert.unspecified(
            mlm.recoverERC20(other.address, u1, SCALE, {from: u1})
        );
    });

    // --------------------------------------------------------------------------
    // Event emission tests
    // --------------------------------------------------------------------------

    it("emits correct events on user join", async () => {
        const adminCode = await mlm.referralCodes(admin);
        
        const tx = await mlm.joinProgram(adminCode, {from: u1});
        
        // Check for UserJoined event
        const userJoinedEvent = tx.logs.find(log => log.event === 'UserJoined');
        assert.isTrue(!!userJoinedEvent, "UserJoined event should be emitted");
        assert.equal(userJoinedEvent.args.user, u1, "UserJoined event should have correct user");
        assert.equal(userJoinedEvent.args.parent, admin, "UserJoined event should have correct parent");
        
        // Check for DirectEarning event
        const directEarningEvent = tx.logs.find(log => log.event === 'DirectEarning');
        assert.isTrue(!!directEarningEvent, "DirectEarning event should be emitted");
        assert.equal(directEarningEvent.args.user, admin, "DirectEarning event should have admin as user");
        assert.equal(directEarningEvent.args.amount.toString(), DIRECT_REWARD.toString(), "DirectEarning event should have correct amount");
    });

    it("emits correct events on multi-level join with indirect earnings", async () => {
        // A joins using admin's code
        const adminCode = await mlm.referralCodes(admin);
        await mlm.joinProgram(adminCode, {from: u1});
        
        // B joins using A's code (should trigger indirect earnings for admin)
        const codeA = await mlm.referralCodes(u1);
        const tx = await mlm.joinProgram(codeA, {from: u2});
        
        // Check for UserJoined event
        const userJoinedEvent = tx.logs.find(log => log.event === 'UserJoined');
        assert.isTrue(!!userJoinedEvent, "UserJoined event should be emitted");
        assert.equal(userJoinedEvent.args.user, u2, "UserJoined event should have correct user");
        assert.equal(userJoinedEvent.args.parent, u1, "UserJoined event should have correct parent");
        
        // Check for DirectEarning event (A gets direct reward)
        const directEarningEvent = tx.logs.find(log => log.event === 'DirectEarning');
        assert.isTrue(!!directEarningEvent, "DirectEarning event should be emitted");
        assert.equal(directEarningEvent.args.user, u1, "DirectEarning event should have u1 as user");
        assert.equal(directEarningEvent.args.amount.toString(), DIRECT_REWARD.toString(), "DirectEarning event should have correct amount");
        
        // Check for IndirectEarning event (admin gets indirect reward)
        const indirectEarningEvent = tx.logs.find(log => log.event === 'IndirectEarning');
        assert.isTrue(!!indirectEarningEvent, "IndirectEarning event should be emitted");
        assert.equal(indirectEarningEvent.args.user, admin, "IndirectEarning event should have admin as user");
        assert.equal(indirectEarningEvent.args.amount.toString(), INDIRECT_TOTAL.toString(), "IndirectEarning event should have correct amount");
    });

    it("emits correct events on earnings withdrawal", async () => {
        await mlm.joinProgram("0x000000000000", {from: u1});
        const codeU1 = await mlm.referralCodes(u1);

        // Create 10 direct referrals for u1
        for (let i = 0; i < 10; i++) {
            await mlm.joinProgram(codeU1, {from: rest[i]});
        }

        const tx = await mlm.withdrawEarnings({from: u1});
        
        // Check for EarningsWithdrawn event
        const earningsWithdrawnEvent = tx.logs.find(log => log.event === 'EarningsWithdrawn');
        assert.isTrue(!!earningsWithdrawnEvent, "EarningsWithdrawn event should be emitted");
        assert.equal(earningsWithdrawnEvent.args.user, u1, "EarningsWithdrawn event should have correct user");
        assert.isTrue(earningsWithdrawnEvent.args.amount.gt(0), "EarningsWithdrawn event should have positive amount");
    });

    it("emits correct events on admin withdrawal", async () => {
        const adminCode = await mlm.referralCodes(admin);
        await mlm.joinProgram(adminCode, {from: u1});
        
        const commission = await mlm.adminCommission();
        const tx = await mlm.withdrawAdminFunds(admin, commission, {from: admin});
        
        // Check for AdminWithdrawn event
        const adminWithdrawnEvent = tx.logs.find(log => log.event === 'AdminWithdrawn');
        assert.isTrue(!!adminWithdrawnEvent, "AdminWithdrawn event should be emitted");
        assert.equal(adminWithdrawnEvent.args.to, admin, "AdminWithdrawn event should have correct recipient");
        assert.equal(adminWithdrawnEvent.args.amount.toString(), commission.toString(), "AdminWithdrawn event should have correct amount");
    });

    it("emits correct events on ERC20 recovery", async () => {
        const other = await MockUSDT.new({from: admin});
        const OTHER_SCALE = await scaleOf(other);
        const deposit = OTHER_SCALE.muln(123);

        await other.transfer(mlm.address, deposit, {from: admin});

        const tx = await mlm.recoverERC20(other.address, admin, deposit, {from: admin});
        
        // Check for ERC20Recovered event
        const erc20RecoveredEvent = tx.logs.find(log => log.event === 'ERC20Recovered');
        assert.isTrue(!!erc20RecoveredEvent, "ERC20Recovered event should be emitted");
        assert.equal(erc20RecoveredEvent.args.erc20, other.address, "ERC20Recovered event should have correct token address");
        assert.equal(erc20RecoveredEvent.args.to, admin, "ERC20Recovered event should have correct recipient");
        assert.equal(erc20RecoveredEvent.args.amount.toString(), deposit.toString(), "ERC20Recovered event should have correct amount");
    });
});
