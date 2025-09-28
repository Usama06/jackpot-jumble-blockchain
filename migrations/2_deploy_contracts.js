// const MockUSDT = artifacts.require("MockUSDT");
const MLMReferral = artifacts.require("MLMReferral");

module.exports = async function (deployer, network, accounts) {
    // await deployer.deploy(MockUSDT);
    // const usdt = await MockUSDT.deployed();

    await deployer.deploy(MLMReferral, "0x4Df02c811316277FEd0cbC4E001907955A3BAF36");
};
