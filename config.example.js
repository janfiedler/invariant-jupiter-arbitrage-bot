const {fromFee,toPercent} = require("@invariant-labs/sdk/lib/utils");
const anchor = require("@project-serum/anchor");

const TOKEN = {
    UXD: {address: '7kbnvuGBxxj8AG9qp8Scn56muWGaRaFqxg1FsRp3PaFT', symbol: 'UXD', decimals: 6},
    USDH: {address: 'USDH1SM1ojwWUga67PGrgFWUHibbjqMvuMaDkRJTgkX', symbol: 'USDH', decimals: 6},
    MSOL: {address: 'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So', symbol: 'mSOL', decimals: 9},
    USDC: {address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', symbol: 'USDC', decimals: 6},
    SNY: {address: '4dmKkXNHdgYsXqBHCuMikNQWwVomZURhYvkkX5c4pQ7y', symbol: 'SNY', decimals: 6},
}

const INVARIANT_FEE_TIERS = [
    {fee: fromFee(new anchor.BN(10))},
    {fee: fromFee(new anchor.BN(50))},
    {fee: fromFee(new anchor.BN(100))},
    {fee: fromFee(new anchor.BN(300))},
    {fee: fromFee(new anchor.BN(1000))}
]
// Date template for LPs
const dataTemplate = {
    state: 0, // 0 - not started, 1 - bought tokenY
    invariant: {
        tokenXAddress: null,
        tokenYAddress: null,
        market: null,
        pair: null,
        poolData: null,
        slippage: toPercent(5, 1)
    },
    jupiter: {
        slippage: 5
    },
    xTokenInitialAmount: 0, // Amount after format from tokenAmount
    resultSimulateInvariant: null,
    resultSimulateJupiter: null,
    yTokenBoughtAmount: 0,
    errorCounter: 0,
}

// Settings for LP's
const LPs = [
    {
        fromInvariant: true, // If true, first buy tokenY on invariant and then sell for tokenX on jupiter. False is the opposite.
        bothAssets: true, // If you have funded your wallet with both assets, bot can skip waiting for node sync after first swap
        tokenX: TOKEN.USDC,
        tokenY: TOKEN.MSOL,
        tokenAmount: 0.12,
        minUnitProfit: 100,
        invariantFee: INVARIANT_FEE_TIERS[1],
        data: {...dataTemplate}
    },
    {
        fromInvariant: false,
        bothAssets: true,
        tokenX: TOKEN.USDC,
        tokenY: TOKEN.MSOL,
        tokenAmount: 0.12,
        minUnitProfit: 100,
        invariantFee: INVARIANT_FEE_TIERS[1],
        data: {...dataTemplate}
    }
];

const SETTINGS = {
    pauseAfterTransaction: 2500, // In miliseconds to wait after nodes sync
    LOOP_TIMEOUT: 30,
    JUPITER: {
        onlyDirectRoutes: false, // It ensures only direct routing and also disable split trade trading
    }
}

module.exports = {
    LPs, SETTINGS
}