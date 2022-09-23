const {fromFee} = require("@invariant-labs/sdk/lib/utils");
const anchor = require("@project-serum/anchor");

const TOKEN = {
    UXD: {address: '7kbnvuGBxxj8AG9qp8Scn56muWGaRaFqxg1FsRp3PaFT', symbol: 'UXD', decimals: 6},
    USDH: {address: 'USDH1SM1ojwWUga67PGrgFWUHibbjqMvuMaDkRJTgkX', symbol: 'USDH', decimals: 6},
    MSOL: {address: 'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So', symbol: 'mSOL', decimals: 9},
    USDC: {address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', symbol: 'USDC', decimals: 6},
    SNY: {address: '4dmKkXNHdgYsXqBHCuMikNQWwVomZURhYvkkX5c4pQ7y', symbol: 'SNY', decimals: 6},
}

const INVARIANT_FEE_TIERS = [
    {fee: fromFee(new anchor.BN(1))},
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
        accountX: null,
        accountY: null,
        market: null,
        pair: null,
        poolData: null,
        slippage: 5
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

module.exports = {
    TOKEN, INVARIANT_FEE_TIERS, dataTemplate
}