const MockUSDT = artifacts.require("MockUSDT");
const MLMReferral = artifacts.require("MLMReferral");

module.exports = async function (deployer, network, accounts) {
    let usdtAddress;
    
    if (network === 'polygon') {
        // Real USDT contract address on Polygon mainnet
        usdtAddress = '0xc2132D05D31c914a87C6611C10748AEb04B58e8F';
        console.log('Using real USDT contract on Polygon mainnet:', usdtAddress);
    } else {
        // Deploy MockUSDT for local development and testnets
        await deployer.deploy(MockUSDT);
        const usdt = await MockUSDT.deployed();
        usdtAddress = usdt.address;
        console.log('Deployed MockUSDT for development:', usdtAddress);
    }

    await deployer.deploy(MLMReferral, usdtAddress);
    console.log('MLMReferral deployed with USDT address:', usdtAddress);
};