const { TOKEN, INVARIANT_FEE_TIERS, dataTemplate } = require('./tools.js');

// Settings for LP's
const LPs = [
    {
        fromInvariant: true, // If true, first buy tokenY on invariant and then sell for tokenX on jupiter. False is the opposite.
        bothAssets: true, // If you have funded your wallet with both assets, bot can skip waiting for node sync after first swap
        tokenX: TOKEN.USDC,
        tokenY: TOKEN.MSOL,
        tokenAmount: 0.22,
        minUnitProfit: 400,
        invariantFee: INVARIANT_FEE_TIERS[1],
        data: {...dataTemplate}
    },
    {
        fromInvariant: false,
        bothAssets: true,
        tokenX: TOKEN.USDC,
        tokenY: TOKEN.MSOL,
        tokenAmount: 0.22,
        minUnitProfit: 400,
        invariantFee: INVARIANT_FEE_TIERS[1],
        data: {...dataTemplate}
    }
];

const SETTINGS = {
    pauseAfterTransaction: 0, // In miliseconds to wait after nodes sync
    LOOP_TIMEOUT: 30,
    JUPITER: {
        onlyDirectRoutes: true, // It ensures only direct routing and also disable split trade trading
    }
}

module.exports = {
    LPs, SETTINGS
}