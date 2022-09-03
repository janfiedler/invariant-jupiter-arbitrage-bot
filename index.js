require("dotenv").config();
const anchor = require("@project-serum/anchor");
const {TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID} = require("@solana/spl-token");
const {Market, Pair, Network} = require('@invariant-labs/sdk')
const {Keypair, PublicKey, Connection} = require('@solana/web3.js');
const {fromFee, simulateSwap} = require('@invariant-labs/sdk/lib/utils')
const {Jupiter} = require("@jup-ag/core");
const JSBI = require('jsbi');

const {KEYPAIR, RPC_ENDPOINT} = process.env;

const {LPs, SETTINGS} = require('./config');

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

const transferAmountToUi = function (value, digits) {
    return value / Math.pow(10, digits);
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

async function simulateInvariant(LP, amountIn) {
    const {fromInvariant, tokenX, tokenY, invariantFee, data} = LP;
    data.invariant.tokenXAddress = tokenX.address;
    data.invariant.tokenYAddress = tokenY.address;
    data.invariant.market = await Market.build(Network.MAIN, keypair, connection);
    data.invariant.pair = new Pair(new PublicKey(data.invariant.tokenXAddress), new PublicKey(data.invariant.tokenYAddress), invariantFee);
    data.invariant.poolData = await data.invariant.market.getPool(data.invariant.pair);

    const result = await simulateSwap({
        xToY: fromInvariant,
        byAmountIn: true,
        swapAmount: new anchor.BN(amountIn),
        priceLimit: data.invariant.poolData.sqrtPrice,
        slippage: data.invariant.slippage,
        tickmap: await data.invariant.market.getTickmap(data.invariant.pair),
        pool: data.invariant.poolData
    });

    //console.log(data.invariant.poolData.liquidity.v.toString())
    return result;
}

async function swapInvariant(LP, amount) {
    const {fromInvariant, data} = LP;
    // Get the associated account for the token in wallet.
    const [accountX, accountY] = await Promise.all([
        PublicKey.findProgramAddress(
            [
                keypair.publicKey.toBuffer(),
                TOKEN_PROGRAM_ID.toBuffer(),
                new PublicKey(data.invariant.tokenXAddress).toBuffer(),
            ],
            ASSOCIATED_TOKEN_PROGRAM_ID
        ),
        PublicKey.findProgramAddress(
            [
                keypair.publicKey.toBuffer(),
                TOKEN_PROGRAM_ID.toBuffer(),
                new PublicKey(data.invariant.tokenYAddress).toBuffer(),
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
        estimatedPriceAfterSwap: {v: data.resultSimulateInvariant.priceAfterSwap},
        slippage: data.invariant.slippage,
        pair: data.invariant.pair,
        owner: keypair.publicKey,
    }

    //Perform the swap
    return await data.invariant.market.swap(swapVars, keypair);
}

async function simulateJupiter(jupiter, LP, from, to, amount) {
    const {data} = LP;
    const routes = await jupiter.computeRoutes({
        inputMint: new PublicKey(from.address), // Mint address of the input token
        outputMint: new PublicKey(to.address), // Mint address of the output token
        amount, // raw input amount of tokens
        slippage: data.jupiter.slippage, // The slippage in % terms
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

async function verifyRequiredBalance(LP) {
    const tokenOutAmountInWallet = await getTokenAddressBalance(LP.tokenY.address);
    console.log("LP.tokenY.address", LP.tokenY.address);
    if (tokenOutAmountInWallet.uiAmount < transferAmountToUi(
        LP.data.yTokenBoughtAmount,
        LP.tokenY.decimals
    )) {
        console.log("Required bought amount is not in wallet", LP.data.yTokenBoughtAmount);
        console.log(tokenOutAmountInWallet);
        LP.data.errorCounter++;
        if (LP.data.errorCounter >= 3) {
            console.log("Error counter is more than 3, reset setting due to false error");
            LP.data.state = 0;
            console.log(LP.data);
            //process.exit(1);
        }
        return false;
    } else {
        console.log("Required amount is in wallet");
        console.log(tokenOutAmountInWallet);
        console.log(LP.data);
        LP.data.errorCounter = 0;
        return true;
    }
}

// create and call async main function
async function main(LP, jupiter) {

    //Create console log with divider
    console.log('-----------------------------------------------------------------------------------------------------------------');
    console.log(`Processing ${LP.tokenX.symbol} / ${LP.tokenY.symbol} with amount ${LP.tokenAmount} and fromInvariant ${LP.fromInvariant}`);

    try {
        if (LP.fromInvariant) {
            if (LP.data.state === 0) {
                LP.data.xTokenInitialAmount = transferAmountToSolana(
                    LP.tokenAmount,
                    LP.tokenX.decimals
                );
                LP.data.resultSimulateInvariant = await simulateInvariant(LP, LP.data.xTokenInitialAmount);
                console.log(`Invarinat => ${LP.data.resultSimulateInvariant.accumulatedAmountIn.add(LP.data.resultSimulateInvariant.accumulatedFee).toString()} ${LP.tokenX.symbol} => ${LP.data.resultSimulateInvariant.accumulatedAmountOut.toString()} ${LP.tokenY.symbol}`)
                LP.data.yTokenBoughtAmount = LP.data.resultSimulateInvariant.accumulatedAmountOut;

                LP.data.resultSimulateJupiter = await simulateJupiter(jupiter, LP, LP.tokenY, LP.tokenX, JSBI.BigInt(LP.data.yTokenBoughtAmount));
                console.log(`Jupiter => ${JSBI.toNumber(LP.data.resultSimulateJupiter.routesInfos[0].inAmount)} ${LP.tokenY.symbol} => ${JSBI.toNumber(LP.data.resultSimulateJupiter.routesInfos[0].outAmount)} ${LP.tokenX.symbol}`)
            }

            const toOutAmount = JSBI.toNumber(LP.data.resultSimulateJupiter.routesInfos[0].outAmount);
            //console.log("fromInAmount", LP.data.xTokenInitialAmount);
            //console.log("toOutAmount", toOutAmount);
            console.log("diff", (toOutAmount - LP.data.xTokenInitialAmount));
            if ((toOutAmount > LP.data.xTokenInitialAmount) && ((toOutAmount - LP.data.xTokenInitialAmount) > LP.minUnitProfit)) {
                if (LP.data.state === 0) {
                    console.log("Swap out is bigger than swap in");
                    console.log("Processing Invariant swap");
                    const resultInvariantSwap = await swapInvariant(LP, LP.data.xTokenInitialAmount);
                    console.log("Invariant swap done", resultInvariantSwap);
                    if (resultInvariantSwap) {
                        LP.data.state = 1
                    }
                    if(!LP.bothAssets) {
                        await sleep(SETTINGS.pauseAfterTransaction);
                    }
                } else if (LP.data.state === 1) {
                    console.log("Continue with Jupiter swap after some error");
                    //Need verification of balance after failed swap
                    const resultRequiredBalance = await verifyRequiredBalance(LP);
                    if (!resultRequiredBalance) {
                        return;
                    }
                }

                console.log("Processing Jupiter swap");
                const resultJupiterSwap = await swapJupiter(jupiter, LP.data.resultSimulateJupiter.routesInfos[0]);
                if (resultJupiterSwap.txid) {
                    LP.data.state = 0;
                    console.log("Jupiter swap done");
                }
                await sleep(SETTINGS.pauseAfterTransaction);
            } else {
                console.log("Swap in is bigger than swap out");
            }
        } else {
            if (LP.data.state === 0) {
                LP.data.xTokenInitialAmount = transferAmountToSolana(
                    LP.tokenAmount,
                    LP.tokenX.decimals
                );
                LP.data.resultSimulateJupiter = await simulateJupiter(jupiter, LP, LP.tokenX, LP.tokenY, JSBI.BigInt(LP.data.xTokenInitialAmount));
                console.log(`Jupiter => ${JSBI.toNumber(LP.data.resultSimulateJupiter.routesInfos[0].inAmount)} ${LP.tokenX.symbol} => ${JSBI.toNumber(LP.data.resultSimulateJupiter.routesInfos[0].outAmount)} ${LP.tokenY.symbol}`)
                LP.data.yTokenBoughtAmount = JSBI.toNumber(LP.data.resultSimulateJupiter.routesInfos[0].outAmount);

                LP.data.resultSimulateInvariant = await simulateInvariant(LP, LP.data.yTokenBoughtAmount);
                console.log(`Invariant => ${LP.data.resultSimulateInvariant.accumulatedAmountIn} (fee:${LP.data.resultSimulateInvariant.accumulatedFee}) ${LP.tokenY.symbol} => ${LP.data.resultSimulateInvariant.accumulatedAmountOut.toString()} ${LP.tokenX.symbol}`)
            }

            const toOutAmount = Number(LP.data.resultSimulateInvariant.accumulatedAmountOut);
            //console.log("fromInAmount", LP.data.xTokenInitialAmount);
            //console.log("toOutAmount", toOutAmount);
            console.log("diff", (toOutAmount - LP.data.xTokenInitialAmount));
            if ((toOutAmount > LP.data.xTokenInitialAmount) && ((toOutAmount - LP.data.xTokenInitialAmount) > LP.minUnitProfit)) {
                if (LP.data.state === 0) {
                    console.log("Swap out is bigger than swap in");
                    console.log("Processing jupiter swap");
                    const resultJupiterSwap = await swapJupiter(jupiter, LP.data.resultSimulateJupiter.routesInfos[0]);
                    if (resultJupiterSwap.error) {
                        // For case, this error was false, set state to 1 to revalidate swap
                        LP.data.state = 1;
                        return;
                    } else if (resultJupiterSwap.txid) {
                        LP.data.state = 1;
                        LP.data.yTokenBoughtAmount = resultJupiterSwap.outputAmount;
                        console.log("Jupiter swap done");
                    }
                    if(!LP.bothAssets) {
                        await sleep(SETTINGS.pauseAfterTransaction);
                    }
                } else if (LP.data.state === 1) {
                    console.log("Continue with Invariant swap after some error");
                    //Need verification of balance after failed swap
                    const resultRequiredBalance = await verifyRequiredBalance(LP);
                    if (!resultRequiredBalance) {
                        return;
                    }
                }
                console.log("Processing Invariant swap");
                const resultInvariantSwap = await swapInvariant(LP, LP.data.yTokenBoughtAmount);
                if (resultInvariantSwap) {
                    LP.data.state = 0;
                    console.log("Invariant swap done", resultInvariantSwap);
                    await sleep(SETTINGS.pauseAfterTransaction);
                }
            } else {
                console.log("Swap in is bigger than swap out");
            }
        }
    } catch (error) {
        console.log(error);
    }
}

async function begin(jupiter) {
    // Loop through all settings
    for (const LP of LPs) {
        // Call main function with current setting
        await main(LP, jupiter);
    }
    await sleep(SETTINGS.LOOP_TIMEOUT * 1000);
    begin(jupiter);
}

// Create empty async function that start immediately
(async () => {
    //Init jupiter
    const jupiter = await Jupiter.load({
        connection,
        cluster: "mainnet-beta",
        user: keypair, // or public key
        // platformFeeAndAccounts:  NO_PLATFORM_FEE,
        routeCacheDuration: 10_000, // Will not refetch data on computeRoutes for up to 10 seconds
    });
    begin(jupiter);
})();