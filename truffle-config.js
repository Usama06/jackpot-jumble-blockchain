require('dotenv').config();
const HDWalletProvider = require('@truffle/hdwallet-provider');

module.exports = {
    networks: {
        development: {
            host: "127.0.0.1",     // Localhost (default: none)
            port: 7545,            // Standard Ethereum port (default: none)
            network_id: "5777",    // Any network (default: none)
            gas: 8000000,          // Gas limit for development
            gasPrice: 20000000000  // 20 gwei
        },
        polygon: {
            provider: () =>
                new HDWalletProvider(
                    process.env.PRIVATE_KEY,
                    process.env.POLYGON_RPC_URL
                ),
            network_id: 137,
            confirmations: 0,              // No confirmations required
            timeoutBlocks: 200,
            networkCheckTimeout: 1000000,
            skipDryRun: true,
            gas: 8000000,
            gasPrice: 30000000000,
            from: process.env.DEPLOYER_ADDRESS,
            // Disable polling to prevent PollingBlockTracker errors
            polling: false
        },
        mumbai: {
            provider: () =>
                new HDWalletProvider(
                    process.env.PRIVATE_KEY,
                    'https://polygon-mumbai.g.alchemy.com/v2/vLdSAoe5PvbxBDWSLAk2_BGriSoyf36B'
                ),
            network_id: 80001,
            confirmations: 2,
            timeoutBlocks: 200,
            networkCheckTimeout: 500000,
            skipDryRun: true,
            gas: 8000000,
            gasPrice: 20000000000  // 20 gwei for testnet
        }
    },

    // Set default mocha options here, use special reporters, etc.
    mocha: {
        timeout: 300000  // Increased timeout for large deployments
    },

    plugins: ["truffle-plugin-verify"],
    api_keys: {
        polygonscan: process.env.POLYGONSCAN_API_KEY
    },

    // Configure your compilers
    compilers: {
        solc: {
            version: "0.8.19",
            settings: {
                optimizer: {
                    enabled: true,
                    runs: 200  // Enable optimizer for gas efficiency
                }
            }
        }
    }
};