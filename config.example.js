const {TOKEN, INVARIANT_FEE_TIERS, dataTemplate} = require('./tools.js');

// Settings for LP's
const LPs = [
    {
        bothAssets: true, // If you have funded your wallet with both assets, bot can skip waiting for node sync after first swap
        fromInvariant: true, // If you want to start swap from the invariant to jupiter first
        tokenX: TOKEN.USDC,
        tokenY: TOKEN.MSOL,
        tokenAmount: 0.2,
        minUnitProfit: 400,
        invariantFee: INVARIANT_FEE_TIERS[2],
        dataInvJup: {...dataTemplate},
        dataJupInv: {...dataTemplate},
        JUPITER: {
            onlyDirectRoutes: true, // It ensures only direct routing and also disable split trade trading
        }
    },
    {
        bothAssets: false,
        tokenX: TOKEN.USDC,
        tokenY: TOKEN.USDH,
        tokenAmount: 1,
        minUnitProfit: 400,
        invariantFee: INVARIANT_FEE_TIERS[0],
        dataInvJup: {...dataTemplate},
        dataJupInv: {...dataTemplate},
        JUPITER: {
            onlyDirectRoutes: true, // It ensures only direct routing and also disable split trade trading
        }
    }
];

const SETTINGS = {
    pauseAfterTransaction: 2, // In seconds to wait after nodes sync
    LOOP_TIMEOUT: 30 // In seconds
}

module.exports = {
    LPs, SETTINGS
}