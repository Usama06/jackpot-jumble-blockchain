const MockUSDT = artifacts.require("MockUSDT");
const MLMReferral = artifacts.require("MLMReferral");

module.exports = async function (deployer, network, accounts) {
    await deployer.deploy(MockUSDT);
    const usdt = await MockUSDT.deployed();

    await deployer.deploy(MLMReferral, usdt.address);
};
