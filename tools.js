import {fromFee} from "@invariant-labs/sdk/lib/utils.js";
import Anchor from '@project-serum/anchor';
const { Provider, BN, utils } = Anchor;

const TOKEN = {
    WSOL: {address: 'So11111111111111111111111111111111111111112', symbol: 'SOL', decimals: 9},
    UXD: {address: '7kbnvuGBxxj8AG9qp8Scn56muWGaRaFqxg1FsRp3PaFT', symbol: 'UXD', decimals: 6},
    USDH: {address: 'USDH1SM1ojwWUga67PGrgFWUHibbjqMvuMaDkRJTgkX', symbol: 'USDH', decimals: 6},
    MSOL: {address: 'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So', symbol: 'mSOL', decimals: 9},
    USDC: {address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', symbol: 'USDC', decimals: 6},
    SNY: {address: '4dmKkXNHdgYsXqBHCuMikNQWwVomZURhYvkkX5c4pQ7y', symbol: 'SNY', decimals: 6},
    MNDE: {address: 'MNDEFzGvMt87ueuHvVU9VcTqsAP5b3fTGPsHuuPA5ey', symbol: 'MNDE', decimals: 9},
    WETH: {address: '7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs', symbol: 'WETH', decimals: 8},
    WSTETH: {address: 'ZScHuTtqZukUrtZS43teTKGs2VqkKL8k4QCouR2n6Uo', symbol: 'WSTETH', decimals: 8}
}

const INVARIANT_FEE_TIERS = [
    { fee: fromFee(new BN(1))},
    { fee: fromFee(new BN(10))},
    { fee: fromFee(new BN(50))},
    { fee: fromFee(new BN(100))},
    { fee: fromFee(new BN(300))},
    { fee: fromFee(new BN(1000))},
    { fee: fromFee(new BN(5000)), tickSpacing: 5 },
    { fee: fromFee(new BN(10000)), tickSpacing: 5 },
    { fee: fromFee(new BN(50000)), tickSpacing: 5 }
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

export { TOKEN, INVARIANT_FEE_TIERS, dataTemplate };