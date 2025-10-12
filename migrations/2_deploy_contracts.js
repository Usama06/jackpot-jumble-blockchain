const MLMReferral = artifacts.require("MLMReferral");

module.exports = async function (deployer, network, accounts) {
    // For mainnet, use the real USDT contract address
    const USDT_ADDRESS = network === 'polygon' 
        ? '0xc2132D05D31c914a87C6611C10748AEb04B58e8F'  // USDT on Polygon
        : (await artifacts.require("MockUSDT").deployed()).address;

    await deployer.deploy(MLMReferral, USDT_ADDRESS);
};