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

// Catch request to exit process, wait until round is finished
let running = true;
let countSigint = 0;
process.on('SIGINT', () => {
    console.log("Caught request to exit process, waiting until round is finished");
    if (countSigint > 0) {
        console.log("Caught request to exit process again, exiting now");
        process.exit(1);
    }
    countSigint++;
    running = false;
});

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

async function simulateInvariant(LP, fromInvariant, data, amountIn) {
    const {tokenX, tokenY, invariantFee} = LP;
    data.invariant.tokenXAddress = tokenX.address;
    data.invariant.tokenYAddress = tokenY.address;
    data.invariant.market = await Market.build(Network.MAIN, keypair, connection);
    data.invariant.pair = new Pair(new PublicKey(data.invariant.tokenXAddress), new PublicKey(data.invariant.tokenYAddress), invariantFee);
    data.invariant.ticks = new Map(
        (await data.invariant.market.getAllTicks(data.invariant.pair)).map(tick => {
            return [tick.index, tick]
        })
    )
    data.invariant.poolData = await data.invariant.market.getPool(data.invariant.pair);

    const result = await simulateSwap({
        xToY: fromInvariant,
        byAmountIn: true,
        swapAmount: new anchor.BN(amountIn),
        priceLimit: data.invariant.poolData.sqrtPrice,
        slippage: data.invariant.slippage,
        ticks: data.invariant.ticks,
        tickmap: await data.invariant.market.getTickmap(data.invariant.pair),
        pool: data.invariant.poolData
    });

    //console.log(data.invariant.poolData.liquidity.v.toString())
    return result;
}

async function swapInvariant(fromInvariant, data,  amount) {
    // Get the associated account for the token in wallet if not already found
    if(!data.invariant.accountX || !data.invariant.accountY){
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
        ]);
        data.invariant.accountX = accountX[0];
        data.invariant.accountY = accountY[0];
    }

    const swapVars = {
        xToY: fromInvariant,
        accountX: data.invariant.accountX,
        accountY: data.invariant.accountY,
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

async function simulateJupiter(jupiter, data, from, to, amount) {
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

async function verifyRequiredBalance(LP, data) {
    const tokenOutAmountInWallet = await getTokenAddressBalance(LP.tokenY.address);
    console.log("LP.tokenY.address", LP.tokenY.address);
    if (tokenOutAmountInWallet.uiAmount < transferAmountToUi(
        data.yTokenBoughtAmount,
        LP.tokenY.decimals
    )) {
        console.log("Required bought amount is not in wallet", data.yTokenBoughtAmount);
        console.log(tokenOutAmountInWallet);
        data.errorCounter++;
        if (data.errorCounter >= 3) {
            console.log("Error counter is more than 3, reset setting due to false error");
            data.state = 0;
            console.log(LP.data);
            //process.exit(1);
        }
        return false;
    } else {
        console.log("Required amount is in wallet");
        console.log(tokenOutAmountInWallet);
        console.log(LP.data);
        data.errorCounter = 0;
        return true;
    }
}

// create and call async main function
async function main(LP, fromInvariant, jupiter) {

    //Create console log with divider
    console.log('-----------------------------------------------------------------------------------------------------------------');
    console.log(`Processing ${LP.tokenX.symbol} / ${LP.tokenY.symbol} with amount ${LP.tokenAmount} and fromInvariant ${fromInvariant}`);

    try {
        if (fromInvariant) {
            if (LP.dataInvJup.state === 0) {
                LP.dataInvJup.xTokenInitialAmount = transferAmountToSolana(
                    LP.tokenAmount,
                    LP.tokenX.decimals
                );
                LP.dataInvJup.resultSimulateInvariant = await simulateInvariant(LP, fromInvariant, LP.dataInvJup, LP.dataInvJup.xTokenInitialAmount);
                console.log(`Invarinat => ${LP.dataInvJup.resultSimulateInvariant.accumulatedAmountIn.add(LP.dataInvJup.resultSimulateInvariant.accumulatedFee).toString()} ${LP.tokenX.symbol} => ${LP.dataInvJup.resultSimulateInvariant.accumulatedAmountOut.toString()} ${LP.tokenY.symbol}`)
                LP.dataInvJup.yTokenBoughtAmount = LP.dataInvJup.resultSimulateInvariant.accumulatedAmountOut;

                LP.dataInvJup.resultSimulateJupiter = await simulateJupiter(jupiter, LP.dataInvJup, LP.tokenY, LP.tokenX, JSBI.BigInt(LP.dataInvJup.yTokenBoughtAmount));
                console.log(`Jupiter => ${JSBI.toNumber(LP.dataInvJup.resultSimulateJupiter.routesInfos[0].inAmount)} ${LP.tokenY.symbol} => ${JSBI.toNumber(LP.dataInvJup.resultSimulateJupiter.routesInfos[0].outAmount)} ${LP.tokenX.symbol}`)
            }

            const toOutAmount = JSBI.toNumber(LP.dataInvJup.resultSimulateJupiter.routesInfos[0].outAmount);
            //console.log("fromInAmount", LP.dataInvJup.xTokenInitialAmount);
            //console.log("toOutAmount", toOutAmount);
            console.log("diff", (toOutAmount - LP.dataInvJup.xTokenInitialAmount));
            if ((toOutAmount > LP.dataInvJup.xTokenInitialAmount) && ((toOutAmount - LP.dataInvJup.xTokenInitialAmount) > LP.minUnitProfit)) {

                console.log("Swap out is bigger than swap in");
                // Jupiter changing price faster than invariant (low volume), we must do jupiter swap fast as possible.
                if (LP.bothAssets) {
                    //Invariant provide output amount only from simulate, not finale swap. We don't know much final amount is, so if we have both assets in wallet, we can do parallel swap.
                    console.log("Processing Invariant and Jupiter swap in parallel");
                    const [resultInvariantSwap, resultJupiterSwap] = await Promise.all([
                        swapInvariant(fromInvariant, LP.dataInvJup, LP.dataInvJup.xTokenInitialAmount),
                        swapJupiter(jupiter, LP.dataInvJup.resultSimulateJupiter.routesInfos[0])
                    ]);
                    if (resultInvariantSwap) {
                        console.log("Invariant swap done", resultInvariantSwap);
                    }
                    if (resultJupiterSwap.txid) {
                        console.log("Jupiter swap done");
                    }
                    LP.tempLoopTimeout = 0;
                } else {
                    if (LP.dataInvJup.state === 0) {
                        console.log("Processing Invariant swap");
                        const resultInvariantSwap = await swapInvariant(fromInvariant, LP.dataInvJup, LP.dataInvJup.xTokenInitialAmount);
                        console.log("Invariant swap done", resultInvariantSwap);
                        if (resultInvariantSwap) {
                            LP.dataInvJup.state = 1
                        }
                    } else if (LP.dataInvJup.state === 1) {
                        console.log("Continue with Jupiter swap after some error");
                        //Need verification of balance after failed swap
                        const resultRequiredBalance = await verifyRequiredBalance(LP, LP.dataInvJup);
                        if (!resultRequiredBalance) {
                            return;
                        }
                    }
                    console.log("Processing Jupiter swap");
                    const resultJupiterSwap = await swapJupiter(jupiter, LP.dataInvJup.resultSimulateJupiter.routesInfos[0]);
                    if (resultJupiterSwap.txid) {
                        LP.dataInvJup.state = 0;
                        console.log("Jupiter swap done");
                        LP.tempLoopTimeout = 0;
                    }
                }
                await sleep(SETTINGS.pauseAfterTransaction);
            } else {
                console.log("Swap in is bigger than swap out");
            }
        } else {
            if (LP.dataJupInv.state === 0) {
                LP.dataJupInv.xTokenInitialAmount = transferAmountToSolana(
                    LP.tokenAmount,
                    LP.tokenX.decimals
                );
                LP.dataJupInv.resultSimulateJupiter = await simulateJupiter(jupiter, LP.dataJupInv, LP.tokenX, LP.tokenY, JSBI.BigInt(LP.dataJupInv.xTokenInitialAmount));
                console.log(`Jupiter => ${JSBI.toNumber(LP.dataJupInv.resultSimulateJupiter.routesInfos[0].inAmount)} ${LP.tokenX.symbol} => ${JSBI.toNumber(LP.dataJupInv.resultSimulateJupiter.routesInfos[0].outAmount)} ${LP.tokenY.symbol}`)
                LP.dataJupInv.yTokenBoughtAmount = JSBI.toNumber(LP.dataJupInv.resultSimulateJupiter.routesInfos[0].outAmount);

                LP.dataJupInv.resultSimulateInvariant = await simulateInvariant(LP, fromInvariant, LP.dataJupInv, LP.dataJupInv.yTokenBoughtAmount);
                console.log(`Invariant => ${LP.dataJupInv.resultSimulateInvariant.accumulatedAmountIn} (fee:${LP.dataJupInv.resultSimulateInvariant.accumulatedFee}) ${LP.tokenY.symbol} => ${LP.dataJupInv.resultSimulateInvariant.accumulatedAmountOut.toString()} ${LP.tokenX.symbol}`)
            }

            const toOutAmount = Number(LP.dataJupInv.resultSimulateInvariant.accumulatedAmountOut);
            //console.log("fromInAmount", LP.dataJupInv.xTokenInitialAmount);
            //console.log("toOutAmount", toOutAmount);
            console.log("diff", (toOutAmount - LP.dataJupInv.xTokenInitialAmount));
            if ((toOutAmount > LP.dataJupInv.xTokenInitialAmount) && ((toOutAmount - LP.dataJupInv.xTokenInitialAmount) > LP.minUnitProfit)) {
                if (LP.dataJupInv.state === 0) {
                    console.log("Swap out is bigger than swap in");
                    console.log("Processing jupiter swap");
                    const resultJupiterSwap = await swapJupiter(jupiter, LP.dataJupInv.resultSimulateJupiter.routesInfos[0]);
                    if (resultJupiterSwap.error) {
                        // For case, this error was false, set state to 1 to revalidate swap
                        LP.dataJupInv.state = 1;
                        return;
                    } else if (resultJupiterSwap.txid) {
                        LP.dataJupInv.state = 1;
                        LP.dataJupInv.yTokenBoughtAmount = resultJupiterSwap.outputAmount;
                        console.log("Jupiter swap done");
                    }
                    if (!LP.bothAssets) {
                        await sleep(SETTINGS.pauseAfterTransaction);
                    }
                } else if (LP.dataJupInv.state === 1) {
                    console.log("Continue with Invariant swap after some error");
                    //Need verification of balance after failed swap
                    const resultRequiredBalance = await verifyRequiredBalance(LP, LP.dataJupInv);
                    if (!resultRequiredBalance) {
                        return;
                    }
                }
                console.log("Processing Invariant swap");
                const resultInvariantSwap = await swapInvariant(fromInvariant, LP.dataJupInv, LP.dataJupInv.yTokenBoughtAmount);
                if (resultInvariantSwap) {
                    LP.dataJupInv.state = 0;
                    LP.tempLoopTimeout = 0;
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
    // If running true, do job else return and finish
    if (running) {
        let tempLoopTimeout = false;
        // Loop through all settings
        for (const LP of LPs) {
            // Set default loop timeout for current LP
            LP.tempLoopTimeout = SETTINGS.LOOP_TIMEOUT;
            // Call main function.
            // fromInvariant:
            // TRUE = buy on invariant and sell on jupiter
            // FALSE = buy on jupiter and sell on invariant

            //First try trade same way as last cycle (don't waste time with opposite trade)
            if(LP.fromInvariant) {
                await main(LP, true, jupiter);
                LP.fromInvariant = LP.tempLoopTimeout === 0;
            }
            //If swap fromInvariant toJupiter not executed, try fromJupiter toInvariant
            if(!LP.fromInvariant) {
                await main(LP, false, jupiter);
                LP.fromInvariant = LP.tempLoopTimeout !== 0;
            }
            // If some LP is after swap, do not sleep and try if are conditions for another loop with swap
            tempLoopTimeout = LP.tempLoopTimeout === 0;
        }
        if (tempLoopTimeout) {
            await sleep(100);
        } else {
            await sleep(SETTINGS.LOOP_TIMEOUT * 1000);
        }
        begin(jupiter);
    }
}

// Create empty async function that start immediately
(async () => {
    //Init jupiter
    const jupiter = await Jupiter.load({
        connection,
        cluster: "mainnet-beta",
        user: keypair, // or public key
        // platformFeeAndAccounts:  NO_PLATFORM_FEE,
        routeCacheDuration: 0, // refetch data on computeRoutes
    });
    begin(jupiter);
})();