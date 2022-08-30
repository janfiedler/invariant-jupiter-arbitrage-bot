require("dotenv").config();
const anchor = require("@project-serum/anchor");
const {TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID} = require("@solana/spl-token");
const {Market, Pair, Network} = require('@invariant-labs/sdk')
const {Keypair, PublicKey, Connection} = require('@solana/web3.js');
const {fromFee, simulateSwap, toPercent} = require('@invariant-labs/sdk/lib/utils')
const {Jupiter} = require("@jup-ag/core");
const JSBI = require('jsbi');

const {KEYPAIR, RPC_ENDPOINT} = process.env;

const {SETTINGS, LPs} = require('./config');

let secretKey = Uint8Array.from(JSON.parse(KEYPAIR));
let keypair = Keypair.fromSecretKey(secretKey);

let connection = new Connection(RPC_ENDPOINT, {confirmTransactionInitialTimeout: 120000});

const sleep = function (ms) {
    return new Promise(resolve => {
        console.log(`Waiting ${ms / 1000} seconds before continue`);
        setTimeout(resolve, ms)
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
    //If tokenAccounts is empty, inform user need to create account for tokenOutAddress
    if (tokenAccounts.value.length === 0) {
        console.log(`Please first create account for tokenOutAddress ${tokenOutAddress}`);
        process.exit(1);
    }
    return tokenAccounts.value[0].account.data.parsed.info.tokenAmount;
}


const tempInvariant = {
    tokenXAddress: null,
    tokenYAddress: null,
    market: null,
    pair: null,
    poolData: null,
    slippage: null
};

async function simulateInvariant(LP, amountIn) {
    const {fromInvariant, tokenX, tokenY, invariantFee} = LP;
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
        forceFetch: true, // false is the default value => will use cache if not older than routeCacheDuration
        onlyDirectRoutes: SETTINGS.JUPITER.onlyDirectRoutes ?? false, // It ensures only direct routing and also disable split trade trading
        intermediateTokens: true, // intermediateTokens, if provided will only find routes that use the intermediate tokens
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
async function main(LP) {

    //Create console log with divider
    console.log('-----------------------------------------------------------------------------------------------------------------');
    console.log(`Processing ${LP.tokenX.symbol} / ${LP.tokenY.symbol} with amount ${LP.tokenAmount} and fromInvariant ${LP.fromInvariant}`);
    const tokenOutAmountInWallet = await getTokenAddressBalance(LP.tokenY.address);

    // If tokenOut is not zero in the wallet, something happened, exit process
    if (tokenOutAmountInWallet.uiAmount > 0.000001 && LP.tokenY.symbol === 'mSOL') {
        console.log("tokenOut amount should be zero");
        console.log(tokenOutAmountInWallet);
        return;
    }

    try {
        //Init jupiter
        const jupiter = await Jupiter.load({
            connection,
            cluster: "mainnet-beta",
            user: keypair, // or public key
            // platformFeeAndAccounts:  NO_PLATFORM_FEE,
            routeCacheDuration: 10_000, // Will not refetch data on computeRoutes for up to 10 seconds
        });

        if (LP.fromInvariant) {
            const tokenInAmount = transferAmountToSolana(
                LP.tokenAmount,
                LP.tokenX.decimals
            );
            const resultSimulateInvariant = await simulateInvariant(LP, tokenInAmount);
            console.log(`Invarinat => ${resultSimulateInvariant.accumulatedAmountIn.add(resultSimulateInvariant.accumulatedFee).toString()} ${LP.tokenX.symbol} => ${resultSimulateInvariant.accumulatedAmountOut.toString()} ${LP.tokenY.symbol}`)

            const resultSimulateJupiter = await simulateJupiter(jupiter, LP.tokenY, LP.tokenX, JSBI.BigInt(resultSimulateInvariant.accumulatedAmountOut), 1);
            console.log(`Jupiter => ${JSBI.toNumber(resultSimulateJupiter.routesInfos[0].inAmount)} ${LP.tokenY.symbol} => ${JSBI.toNumber(resultSimulateJupiter.routesInfos[0].outAmount)} ${LP.tokenX.symbol}`)

            const fromInAmount = Number(resultSimulateInvariant.accumulatedAmountIn.add(resultSimulateInvariant.accumulatedFee));
            const toOutAmount = JSBI.toNumber(resultSimulateJupiter.routesInfos[0].outAmount);
            //console.log("fromInAmount", fromInAmount);
            //console.log("toOutAmount", toOutAmount);
            console.log("diff", (toOutAmount - fromInAmount));
            if ((toOutAmount > fromInAmount) && ((toOutAmount - fromInAmount) > LP.minUnitProfit)) {
                console.log("Swap out is bigger than swap in");
                console.log("Processing Invariant swap");
                const resultInvariantSwap = await swapInvariant(LP.fromInvariant, tokenInAmount, resultSimulateInvariant);
                console.log("Invariant swap done", resultInvariantSwap);
                await sleep(LPS.pauseAfterTransaction);
                console.log("Processing Jupiter swap");
                await swapJupiter(jupiter, resultSimulateJupiter.routesInfos[0]);
                console.log("Jupiter swap done");
                await sleep(LPS.pauseAfterTransaction);
            } else {
                console.log("Swap in is bigger than swap out");
            }
        } else {
            const tokenInAmount = transferAmountToSolana(
                LP.tokenAmount,
                LP.tokenX.decimals
            );
            const resultSimulateJupiter = await simulateJupiter(jupiter, LP.tokenX, LP.tokenY, JSBI.BigInt(tokenInAmount), 1);
            console.log(`Jupiter => ${JSBI.toNumber(resultSimulateJupiter.routesInfos[0].inAmount)} ${LP.tokenX.symbol} => ${JSBI.toNumber(resultSimulateJupiter.routesInfos[0].outAmount)} ${LP.tokenY.symbol}`)

            const resultSimulateInvariant = await simulateInvariant(LP, JSBI.toNumber(resultSimulateJupiter.routesInfos[0].outAmount));
            console.log(`Invariant => ${resultSimulateInvariant.accumulatedAmountIn} (fee:${resultSimulateInvariant.accumulatedFee}) ${LP.tokenY.symbol} => ${resultSimulateInvariant.accumulatedAmountOut.toString()} ${LP.tokenX.symbol}`)

            const fromInAmount = JSBI.toNumber(resultSimulateJupiter.routesInfos[0].inAmount);
            const toOutAmount = Number(resultSimulateInvariant.accumulatedAmountOut);
            //console.log("fromInAmount", fromInAmount);
            //console.log("toOutAmount", toOutAmount);
            console.log("diff", (toOutAmount - fromInAmount));
            if ((toOutAmount > fromInAmount) && ((toOutAmount - fromInAmount) > LP.minUnitProfit)) {
                console.log("Swap out is bigger than swap in");
                console.log("Processing jupiter swap");
                const resultJupiter = await swapJupiter(jupiter, resultSimulateJupiter.routesInfos[0]);
                console.log("Jupiter swap done");
                await sleep(SETTINGS.pauseAfterTransaction);
                console.log("Processing Invariant swap");
                const resultInvariantSwap = await swapInvariant(LP.fromInvariant, resultJupiter.outputAmount, resultSimulateInvariant);
                console.log("Invariant swap done", resultInvariantSwap);
                await sleep(SETTINGS.pauseAfterTransaction);
            } else {
                console.log("Swap in is bigger than swap out");
            }

        }
    } catch (error) {
        console.log(error);
    }
}

async function begin() {
    // Loop through all settings
    for (const LP of LPs) {
        // Call main function with current setting
        await main(LP);
    }
    await sleep(SETTINGS.LOOP_TIMEOUT * 1000);
    begin();
}

// Create empty async function that start immediately
(async () => {
    begin();
})();