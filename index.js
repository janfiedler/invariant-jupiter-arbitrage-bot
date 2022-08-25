require("dotenv").config();
const anchor = require("@project-serum/anchor");
const {TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID} = require("@solana/spl-token");
const {Market, Pair, Network} = require('@invariant-labs/sdk')
const {Keypair, PublicKey, Connection} = require('@solana/web3.js');
const {fromFee, simulateSwap, toPercent} = require('@invariant-labs/sdk/lib/utils')
const {Jupiter} = require("@jup-ag/core");
const JSBI = require('jsbi');

const { KEYPAIR, LOOP_TIMEOUT, RPC_ENDPOINT } = process.env;

let secretKey = Uint8Array.from(JSON.parse(KEYPAIR));
let keypair = Keypair.fromSecretKey(secretKey);

let connection = new Connection(RPC_ENDPOINT, {confirmTransactionInitialTimeout: 300000});

const sleep = function (ms){
    return new Promise(resolve=>{
        console.log(`Waiting ${ms/1000} seconds before continue`);
        setTimeout(resolve,ms)
    })
};

const transferAmountToSolana = function (value, digits) {
    return Math.round(value * Math.pow(10, digits));
};

function relDiff(a, b) {
    return 100 * Math.abs((a - b) / ((a + b) / 2));
}

async function getTokenAddressBalance(tokenOutAddress) {
    // Verify that tokenOut is zero in the wallet
    let tokenAccounts = await connection.getParsedTokenAccountsByOwner(
        keypair.publicKey,
        {programId: TOKEN_PROGRAM_ID}
    );
    // Filter fromm all tokens in wallet only tokenOut address
    tokenAccounts.value = tokenAccounts.value.filter(
        (token) => token.account.data.parsed.info.mint === tokenOutAddress
    );
    return tokenAccounts.value[0].account.data.parsed.info.tokenAmount;
}

const TOKEN = {
    UXD: {address: '7kbnvuGBxxj8AG9qp8Scn56muWGaRaFqxg1FsRp3PaFT', symbol: 'UXD', decimals: 6},
    USDH: {address: 'USDH1SM1ojwWUga67PGrgFWUHibbjqMvuMaDkRJTgkX', symbol: 'USDH', decimals: 6},
    MSOL: {address: 'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So', symbol: 'mSOL', decimals: 9},
    USDC: {address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', symbol: 'USDC', decimals: 6},
}

const INVARIANT_FEE_TIERS = [
    { fee: fromFee(new anchor.BN(10)) },
    { fee: fromFee(new anchor.BN(50)) },
    { fee: fromFee(new anchor.BN(100)) },
    { fee: fromFee(new anchor.BN(300)) },
    { fee: fromFee(new anchor.BN(1000)) }
]

// Settings for LP's
const SETTINGS = [
    /*{
        fromInvariant: true,
        tokenX: TOKEN.USDC,
        tokenY: TOKEN.USDH,
        tokenAmount: 1,
        minUnitProfit: 2000,
        invariantFee: INVARIANT_FEE_TIERS[0],
    },
    {
        fromInvariant: false,
        tokenX: TOKEN.USDC,
        tokenY: TOKEN.USDH,
        tokenAmount: 1,
        minUnitProfit: 2000,
        invariantFee: INVARIANT_FEE_TIERS[0],
    },*/
    {
        fromInvariant: true,
        tokenX: TOKEN.USDH,
        tokenY: TOKEN.MSOL,
        tokenAmount: 0.4,
        minUnitProfit: 1000,
        invariantFee: INVARIANT_FEE_TIERS[1],
    },
    {
        fromInvariant: false,
        tokenX: TOKEN.USDH,
        tokenY: TOKEN.MSOL,
        tokenAmount: 0.4,
        minUnitProfit: 1000,
        invariantFee: INVARIANT_FEE_TIERS[1],
    },
    {
        fromInvariant: true,
        tokenX: TOKEN.UXD,
        tokenY: TOKEN.MSOL,
        tokenAmount: 0.2,
        minUnitProfit: 1000,
        invariantFee: INVARIANT_FEE_TIERS[1],
    },
    {
        fromInvariant: false,
        tokenX: TOKEN.UXD,
        tokenY: TOKEN.MSOL,
        tokenAmount: 0.2,
        minUnitProfit: 1000,
        invariantFee: INVARIANT_FEE_TIERS[1],
    }
]

const tempInvariant = {
    tokenXAddress: null,
    tokenYAddress: null,
    market: null,
    pair: null,
    poolData: null,
    slippage: null
};

async function simulateInvariant(SETTING, amountIn) {
    const {fromInvariant, tokenX, tokenY, invariantFee} = SETTING;
    tempInvariant.tokenXAddress = tokenX.address;
    tempInvariant.tokenYAddress = tokenY.address;
    tempInvariant.market = await Market.build(Network.MAIN, keypair, connection);
    tempInvariant.pair = new Pair(new PublicKey(tempInvariant.tokenXAddress), new PublicKey(tempInvariant.tokenYAddress), invariantFee);
    tempInvariant.poolData = await tempInvariant.market.getPool(tempInvariant.pair);
    tempInvariant.slippage = toPercent(1, 1);
    const result = await simulateSwap({
        xToY: fromInvariant,
        byAmountIn: true,
        swapAmount: new anchor.BN(amountIn),
        priceLimit: tempInvariant.poolData.sqrtPrice,
        slippage: tempInvariant.slippage,
        tickmap: await tempInvariant.market.getTickmap(tempInvariant.pair),
        pool: tempInvariant.poolData
    });

    //console.log(tempInvariant.poolData.liquidity.v.toString())
    return result;
}

async function swapInvariant(fromInvariant, amount, result) {

    // Get the associated account for the token in wallet.
    const [accountX, accountY] = await Promise.all([
        PublicKey.findProgramAddress(
            [
                keypair.publicKey.toBuffer(),
                TOKEN_PROGRAM_ID.toBuffer(),
                new PublicKey(tempInvariant.tokenXAddress).toBuffer(),
            ],
            ASSOCIATED_TOKEN_PROGRAM_ID
        ),
        PublicKey.findProgramAddress(
            [
                keypair.publicKey.toBuffer(),
                TOKEN_PROGRAM_ID.toBuffer(),
                new PublicKey(tempInvariant.tokenYAddress).toBuffer(),
            ],
            ASSOCIATED_TOKEN_PROGRAM_ID
        )
    ])

    const swapVars = {
        xToY: fromInvariant,
        accountX: accountX[0],
        accountY: accountY[0],
        amount: new anchor.BN(amount),
        byAmountIn: true,
        estimatedPriceAfterSwap: {v: result.priceAfterSwap},
        slippage: {v: fromFee(new anchor.BN(1000))},
        pair: tempInvariant.pair,
        owner: keypair.publicKey,
    }

    //Perform the swap
    return await tempInvariant.market.swap(swapVars, keypair);
}

async function simulateJupiter(jupiter, from, to, amount, slippage) {
    const routes = await jupiter.computeRoutes({
        inputMint: new PublicKey(from.address), // Mint address of the input token
        outputMint: new PublicKey(to.address), // Mint address of the output token
        amount, // raw input amount of tokens
        slippage, // The slippage in % terms
        forceFetch: false // false is the default value => will use cache if not older than routeCacheDuration
    });
    return routes;

}

async function swapJupiter(jupiter, routes) {
// Prepare execute exchange
    const {execute} = await jupiter.exchange({
        routeInfo: routes,
    });

// Execute swap
    const swapResult = await execute();
    console.log(swapResult);
    return swapResult;
}

// create and call async main function
async function main(SETTING) {
    //Create console log with divider
    console.log('-----------------------------------------------------------------------------------------------------------------');
    console.log(`Processing ${SETTING.tokenX.symbol} / ${SETTING.tokenY.symbol} with amount ${SETTING.tokenAmount} and fromInvariant ${SETTING.fromInvariant}`);
    const tokenOutAmountInWallet = await getTokenAddressBalance(SETTING.tokenY.address);
    // If tokenOut is not zero in the wallet, something happened, exit process
    if (tokenOutAmountInWallet.uiAmount > 0 && SETTING.tokenY.symbol === 'MSOL') {
        console.log("tokenOut amount should be zero");
        console.log(tokenOutAmountInWallet);
        process.exit(0);
    }

    //Init jupiter
    const jupiter = await Jupiter.load({
        connection,
        cluster: "mainnet-beta",
        user: keypair, // or public key
        // platformFeeAndAccounts:  NO_PLATFORM_FEE,
        routeCacheDuration: 10_000, // Will not refetch data on computeRoutes for up to 10 seconds
    });

    if (SETTING.fromInvariant) {
        const tokenInAmount = transferAmountToSolana(
            SETTING.tokenAmount,
            SETTING.tokenX.decimals
        );
        const resultSimulateInvariant = await simulateInvariant(SETTING, tokenInAmount);
        console.log(`${resultSimulateInvariant.accumulatedAmountIn.add(resultSimulateInvariant.accumulatedFee).toString()} ${SETTING.tokenX.symbol} => ${resultSimulateInvariant.accumulatedAmountOut.toString()} ${SETTING.tokenY.symbol}`)

        const resultSimulateJupiter = await simulateJupiter(jupiter, SETTING.tokenY, SETTING.tokenX, JSBI.BigInt(resultSimulateInvariant.accumulatedAmountOut), 1);
        console.log(`${JSBI.toNumber(resultSimulateJupiter.routesInfos[0].inAmount)} ${SETTING.tokenY.symbol} => ${JSBI.toNumber(resultSimulateJupiter.routesInfos[0].outAmount)} ${SETTING.tokenX.symbol}`)

        const fromInAmount = Number(resultSimulateInvariant.accumulatedAmountIn.add(resultSimulateInvariant.accumulatedFee));
        const toOutAmount = JSBI.toNumber(resultSimulateJupiter.routesInfos[0].outAmount);
        //console.log("fromInAmount", fromInAmount);
        //console.log("toOutAmount", toOutAmount);
        console.log("diff", (toOutAmount - fromInAmount));
        if ((toOutAmount > fromInAmount) && ((toOutAmount - fromInAmount) > SETTING.minUnitProfit)) {
            console.log("Swap out is bigger than swap in");
            console.log("Processing Invariant swap");
            const resultInvariantSwap = await swapInvariant(SETTING.fromInvariant, tokenInAmount, resultSimulateInvariant);
            console.log("Invariant swap done", resultInvariantSwap);
            await sleep(5000);
            console.log("Processing Jupiter swap");
            await swapJupiter(jupiter, resultSimulateJupiter.routesInfos[0]);
            console.log("Jupiter swap done");
            await sleep(5000);
        } else {
            console.log("Swap in is bigger than swap out");
        }
    } else {
        const tokenInAmount = transferAmountToSolana(
            SETTING.tokenAmount,
            SETTING.tokenX.decimals
        );
        const resultSimulateJupiter = await simulateJupiter(jupiter, SETTING.tokenX, SETTING.tokenY, JSBI.BigInt(tokenInAmount), 1);
        console.log(`${JSBI.toNumber(resultSimulateJupiter.routesInfos[0].inAmount)} ${SETTING.tokenX.symbol} => ${JSBI.toNumber(resultSimulateJupiter.routesInfos[0].outAmount)} ${SETTING.tokenY.symbol}`)

        const resultSimulateInvariant = await simulateInvariant(SETTING, JSBI.toNumber(resultSimulateJupiter.routesInfos[0].outAmount));
        console.log(`${resultSimulateInvariant.accumulatedAmountIn} (fee:${resultSimulateInvariant.accumulatedFee}) ${SETTING.tokenY.symbol} => ${resultSimulateInvariant.accumulatedAmountOut.toString()} ${SETTING.tokenX.symbol}`)

        const fromInAmount = JSBI.toNumber(resultSimulateJupiter.routesInfos[0].inAmount);
        const toOutAmount = Number(resultSimulateInvariant.accumulatedAmountOut);
        //console.log("fromInAmount", fromInAmount);
        //console.log("toOutAmount", toOutAmount);
        console.log("diff", (toOutAmount - fromInAmount));
        if ((toOutAmount > fromInAmount) && ((toOutAmount - fromInAmount) > SETTING.minUnitProfit)) {
            console.log("Swap out is bigger than swap in");
            console.log("Processing jupiter swap");
            const resultJupiter = await swapJupiter(jupiter, resultSimulateJupiter.routesInfos[0]);
            console.log("Jupiter swap done");
            if (!resultJupiter.error) {
                await sleep(5000);
                console.log("Processing Invariant swap");
                const resultInvariantSwap = await swapInvariant(SETTING.fromInvariant, resultJupiter.outputAmount, resultSimulateInvariant);
                console.log("Invariant swap done", resultInvariantSwap);
                await sleep(5000);
            } else {
                process.exit(0);
            }
        } else {
            console.log("Swap in is bigger than swap out");
        }

    }
}

async function begin(){
    // Loop through all settings
    for (const SETTING of SETTINGS) {
        // Call main function with current setting
        await main(SETTING);
    }
    await sleep(LOOP_TIMEOUT * 1000);
    begin();
}

// Create empty async function that start immediately
(async () => {
    begin();
})();