import got from "got";
import dotenv from "dotenv";
import Anchor from '@project-serum/anchor';
const { Wallet, Provider, BN, utils } = Anchor;
import {
    ASSOCIATED_TOKEN_PROGRAM_ID,
    TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { Market, Pair, Network } from "@invariant-labs/sdk";
import { Keypair, PublicKey, Connection, VersionedTransaction } from "@solana/web3.js";
import { fromFee, simulateSwap, toPercent } from "@invariant-labs/sdk/lib/utils.js";
import JSBI from 'jsbi';

dotenv.config();
const { KEYPAIR, RPC_ENDPOINT } = process.env;

import { LPs, SETTINGS } from './config.js';

let secretKey = Uint8Array.from(JSON.parse(KEYPAIR));
const wallet = new Wallet(
    Keypair.fromSecretKey(secretKey)
);
let keypair = Keypair.fromSecretKey(secretKey);


let connection = new Connection(RPC_ENDPOINT, { confirmTransactionInitialTimeout: 120000 });

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
        { programId: TOKEN_PROGRAM_ID }
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
    const { tokenX, tokenY, invariantFee } = LP;
    data.invariant.tokenXAddress = tokenX.address;
    data.invariant.tokenYAddress = tokenY.address;
    data.invariant.market = data.invariant.market === null ? await Market.build(Network.MAIN, keypair, connection) : data.invariant.market;
    data.invariant.pair = data.invariant.pair === null ? new Pair(new PublicKey(data.invariant.tokenXAddress), new PublicKey(data.invariant.tokenYAddress), invariantFee) : data.invariant.pair;

    data.invariant.ticks = new Map(
        (await data.invariant.market.getAllTicks(data.invariant.pair)).map(tick => {
            return [tick.index, tick]
        })
    )
    data.invariant.poolData = await data.invariant.market.getPool(data.invariant.pair);

    const result = await simulateSwap({
        xToY: fromInvariant,
        byAmountIn: true,
        swapAmount: new BN(amountIn),
        slippage: toPercent(data.invariant.slippage, 1),
        ticks: data.invariant.ticks,
        tickmap: await data.invariant.market.getTickmap(data.invariant.pair),
        pool: data.invariant.poolData
    });

    return result;
}

async function swapInvariant(fromInvariant, data, amount) {
    console.log("Processing Invariant swap");
    // Get the associated account for the token in wallet if not already found
    if (data.invariant.accountX === null || data.invariant.accountY === null) {
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
        amount: new BN(amount),
        byAmountIn: true,
        estimatedPriceAfterSwap: { v: data.resultSimulateInvariant.priceAfterSwap },
        slippage: toPercent(data.invariant.slippage, 1),
        pair: data.invariant.pair,
        owner: keypair.publicKey,
    }

    //Perform the swap
    let resultInvariantSwap = await data.invariant.market.swap(swapVars, keypair);
    console.log("Invariant swap done");
    console.log(`https://solscan.io/tx/${resultInvariantSwap}`);
    return resultInvariantSwap;
}

const getCoinQuote = (onlyDirectRoutes, inputMint, outputMint, amount) => {
    return got
        .get(
            `https://quote-api.jup.ag/v6/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&slippageBps=50&onlyDirectRoutes=${onlyDirectRoutes}`
        )
        .json();
};

const getTransaction = async (quoteResponse) => {
    try {
        const response = await got.post("https://quote-api.jup.ag/v6/swap", {
            headers: {
                'Content-Type': 'application/json'
            },
            json: {
                quoteResponse,
                userPublicKey: wallet.publicKey.toString(),
                wrapAndUnwrapSol: false
            },
            responseType: 'json'
        });

        return response.body;

    } catch (error) {
        throw new Error(`Got error: ${error.response.body}`);
    }
};

async function simulateJupiter(onlyDirectRoutes, data, from, to, amount) {

    const routes = await getCoinQuote(
        onlyDirectRoutes,
        new PublicKey(from.address),
        new PublicKey(to.address),
        amount
    );

    /*
    const routes = await jupiter.computeRoutes({
        inputMint: new PublicKey(from.address), // Mint address of the input token
        outputMint: new PublicKey(to.address), // Mint address of the output token
        amount, // raw input amount of tokens
        slippageBps: Math.ceil(data.jupiter.slippage*100), // The slippage in % terms
        forceFetch: true, // false is the default value => will use cache if not older than routeCacheDuration
        onlyDirectRoutes, // It ensures only direct routing and also disable split trade trading
        intermediateTokens: true, // intermediateTokens, if provided will only find routes that use the intermediate tokens
    });
    */
    return routes;

}

async function swapJupiter(routes) {
    try{
        console.log("Processing jupiter swap");
        const response = await getTransaction(routes);
        let swapTransaction = response.swapTransaction;
    
        if (typeof swapTransaction === 'undefined') {
            console.log('Undefined swapTransaction');
            process.exit(0);
        }
        else {
            // deserialize the transaction
            const swapTransactionBuf = Buffer.from(swapTransaction, 'base64');
            var transaction = VersionedTransaction.deserialize(swapTransactionBuf);
            //console.log(transaction);
    
            // sign the transaction
            transaction.sign([wallet.payer]);
    
            // Execute the transaction
            const rawTransaction = transaction.serialize()
            const txid = await connection.sendRawTransaction(rawTransaction, {
                skipPreflight: true,
                maxRetries: 2
            });
    
            const result = await connection.confirmTransaction(txid);
            if (result.value.err != null) {
                console.log("Jupiter swap failed:");
                console.log(result.value.err);
                if(result.value.err.InstructionError) {
                    //this is fatal error, not worth to retry
                    return true;
                }
            } else {
                console.log("Jupiter swap done");
                console.log(`https://solscan.io/tx/${txid}`);
            }
            //console.log(result);
            //console.log(result.value.err == null);
            return result.value.err == null;
        }
    } catch (error) {
        console.log("Jupiter swap exception:");
        console.log(error);
        return false;
    } 
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
async function main(LP, fromInvariant) {

    //Create console log with divider
    console.log('-----------------------------------------------------------------------------------------------------------------');
    console.log("[" + new Date().toISOString() + "]");
    console.log(`Processing ${LP.tokenX.symbol} / ${LP.tokenY.symbol} with amount ${LP.tokenAmount} and fromInvariant ${fromInvariant}`);

    try {
        if (fromInvariant) {
            if (LP.dataInvJup.state === 0) {
                LP.dataInvJup.xTokenInitialAmount = transferAmountToSolana(
                    LP.tokenAmount,
                    LP.tokenX.decimals
                );
                LP.dataInvJup.resultSimulateInvariant = await simulateInvariant(LP, fromInvariant, LP.dataInvJup, LP.dataInvJup.xTokenInitialAmount);
                if (LP.dataInvJup.resultSimulateInvariant.accumulatedAmountIn == 0 || LP.dataInvJup.resultSimulateInvariant.accumulatedAmountOut == 0) {
                    console.log(LP.dataInvJup.resultSimulateInvariant.status);
                    return;
                }
                console.log(`Invarinat => ${transferAmountToUi(LP.dataInvJup.resultSimulateInvariant.accumulatedAmountIn.add(LP.dataInvJup.resultSimulateInvariant.accumulatedFee), LP.tokenX.decimals)} ${LP.tokenX.symbol} => ${transferAmountToUi(LP.dataInvJup.resultSimulateInvariant.accumulatedAmountOut, LP.tokenY.decimals)} ${LP.tokenY.symbol}`)
                LP.dataInvJup.yTokenBoughtAmount = LP.dataInvJup.resultSimulateInvariant.accumulatedAmountOut;

                LP.dataInvJup.resultSimulateJupiter = await simulateJupiter(LP.JUPITER.onlyDirectRoutes, LP.dataInvJup, LP.tokenY, LP.tokenX, new BN(LP.dataInvJup.yTokenBoughtAmount));
                console.log(`Jupiter => ${transferAmountToUi(LP.dataInvJup.resultSimulateJupiter.inAmount, LP.tokenY.decimals)} ${LP.tokenY.symbol} => ${transferAmountToUi(LP.dataInvJup.resultSimulateJupiter.outAmount, LP.tokenX.decimals)} ${LP.tokenX.symbol}`);
            }

            const toOutAmount = new BN(LP.dataInvJup.resultSimulateJupiter.outAmount);
            console.log("fromInAmount", transferAmountToUi(LP.dataInvJup.xTokenInitialAmount, LP.tokenX.decimals));
            console.log("toOutAmount", transferAmountToUi(toOutAmount, LP.tokenX.decimals));
            console.log("diff", transferAmountToUi((toOutAmount - LP.dataInvJup.xTokenInitialAmount), LP.tokenX.decimals));
            if ((toOutAmount > LP.dataInvJup.xTokenInitialAmount) && ((toOutAmount - LP.dataInvJup.xTokenInitialAmount) > LP.minUnitProfit)) {

                console.log("Swap out is bigger than swap in");
                if (LP.dataInvJup.state === 0) {
                    const [resultInvariantSwap, resultJupiterSwap] = await Promise.all([swapInvariant(fromInvariant, LP.dataInvJup, LP.dataInvJup.xTokenInitialAmount),
                                                                                        swapJupiter(LP.dataInvJup.resultSimulateJupiter)]);
                    if (resultInvariantSwap && resultJupiterSwap) {
                        LP.dataInvJup.state = 0;
                        LP.tempLoopTimeout = 0;
                    } else if (!resultInvariantSwap && resultJupiterSwap) {
                        LP.dataInvJup.state = 1;
                    } else if (resultInvariantSwap && !resultJupiterSwap) {
                        LP.dataInvJup.state = 2
                    }
                }

                if (LP.dataInvJup.state === 1) {
                    const resultInvariantSwap = await swapInvariant(fromInvariant, LP.dataInvJup, LP.dataInvJup.xTokenInitialAmount);
                    if (resultInvariantSwap) {
                        LP.dataInvJup.state = 0;
                    }
                } else if (LP.dataInvJup.state === 2) {
                    const resultJupiterSwap = await swapJupiter(LP.dataInvJup.resultSimulateJupiter);
                    if (resultJupiterSwap) {
                        LP.dataInvJup.state = 0;
                    }
                }
            } else {
                console.log("Swap in is bigger than swap out");
            }
        } else {
            if (LP.dataJupInv.state === 0) {
                LP.dataJupInv.xTokenInitialAmount = transferAmountToSolana(
                    LP.tokenAmount,
                    LP.tokenX.decimals
                );
                LP.dataJupInv.resultSimulateJupiter = await simulateJupiter(LP.JUPITER.onlyDirectRoutes, LP.dataJupInv, LP.tokenX, LP.tokenY, new BN(LP.dataJupInv.xTokenInitialAmount));
                console.log(`Jupiter => ${transferAmountToUi(LP.dataJupInv.resultSimulateJupiter.inAmount, LP.tokenX.decimals)} ${LP.tokenX.symbol} => ${transferAmountToUi(LP.dataJupInv.resultSimulateJupiter.outAmount, LP.tokenY.decimals)} ${LP.tokenY.symbol}`);
                LP.dataJupInv.yTokenBoughtAmount = new BN(LP.dataJupInv.resultSimulateJupiter.outAmount);

                LP.dataJupInv.resultSimulateInvariant = await simulateInvariant(LP, fromInvariant, LP.dataJupInv, LP.dataJupInv.yTokenBoughtAmount);
                console.log(`Invariant => ${transferAmountToUi(LP.dataJupInv.resultSimulateInvariant.accumulatedAmountIn, LP.tokenY.decimals)} (fee:${transferAmountToUi(LP.dataJupInv.resultSimulateInvariant.accumulatedFee, LP.tokenY.decimals)}) ${LP.tokenY.symbol} => ${transferAmountToUi(LP.dataJupInv.resultSimulateInvariant.accumulatedAmountOut, LP.tokenX.decimals)} ${LP.tokenX.symbol}`);
            }

            const toOutAmount = Number(LP.dataJupInv.resultSimulateInvariant.accumulatedAmountOut);
            console.log("fromInAmount", transferAmountToUi(LP.dataJupInv.xTokenInitialAmount, LP.tokenX.decimals));
            console.log("toOutAmount", transferAmountToUi(toOutAmount, LP.tokenX.decimals));
            console.log("diff", transferAmountToUi((toOutAmount - LP.dataJupInv.xTokenInitialAmount), LP.tokenY.decimals));
            if ((toOutAmount > LP.dataJupInv.xTokenInitialAmount) && ((toOutAmount - LP.dataJupInv.xTokenInitialAmount) > LP.minUnitProfit)) {

                console.log("Swap out is bigger than swap in");
                if (LP.dataJupInv.state === 0) {
                    const [resultJupiterSwap, resultInvariantSwap] = await Promise.all([swapJupiter(LP.dataJupInv.resultSimulateJupiter),
                                                                                        swapInvariant(fromInvariant, LP.dataJupInv, LP.dataJupInv.yTokenBoughtAmount)]);
                    if (resultJupiterSwap && resultInvariantSwap) {
                        LP.dataJupInv.state = 0;
                        LP.tempLoopTimeout = 0;
                    } else if (!resultJupiterSwap && resultInvariantSwap) {
                        LP.dataJupInv.state = 1;
                    } else if (resultJupiterSwap && !resultInvariantSwap) {
                        LP.dataJupInv.state = 2
                    }
                }

                if (LP.dataJupInv.state === 1) {
                    const resultJupiterSwap = await swapJupiter(LP.dataJupInv.resultSimulateJupiter);
                    if (resultJupiterSwap) {
                        LP.dataJupInv.state = 0;
                    }
                } else if (LP.dataJupInv.state === 2) {
                    const resultInvariantSwap = await swapInvariant(fromInvariant, LP.dataJupInv, LP.dataJupInv.yTokenBoughtAmount);
                    if (resultInvariantSwap) {
                        LP.dataJupInv.state = 0;
                    }
                }
            } else {
                console.log("Swap in is bigger than swap out");
            }
        }
    } catch (error) {
        console.log(error);
    }
}

// if LP.bothAssets is true skip sleep function, we don't need to wait on sync node
async function shouldWait(LP) {
    if (!LP.bothAssets) {
        await sleep(SETTINGS.pauseAfterTransaction * 1000);
    }
}

async function begin() {
    // If running true, do job else return and finish
    if (running) {
        let skipLoopTimeout = false;
        // Loop through all settings
        for (const LP of LPs) {
            // Set default loop timeout for current LP
            LP.tempLoopTimeout = SETTINGS.LOOP_TIMEOUT;
            // Call main function.
            // fromInvariant:
            // TRUE = buy on invariant and sell on jupiter
            // FALSE = buy on jupiter and sell on invariant

            //First try trade same way as last cycle (don't waste time with opposite trade)
            if (LP.fromInvariant) {
                await main(LP, true);
                LP.fromInvariant = LP.tempLoopTimeout === 0;
            }
            //If swap fromInvariant toJupiter not executed, try fromJupiter toInvariant
            if (!LP.fromInvariant) {
                await main(LP, false);
                LP.fromInvariant = LP.tempLoopTimeout !== 0;
            }
            // If skipLoopTimeout is false, check if LP swap completed. Then do not sleep and do new loop timidity
            if (!skipLoopTimeout) {
                skipLoopTimeout = LP.tempLoopTimeout === 0;
            }
        }
        if (!skipLoopTimeout) {
            await sleep(SETTINGS.LOOP_TIMEOUT * 1000);
        }
        begin();
    }
}

// Create empty async function that start immediately
(async () => {
    //Init jupiter
    begin();
})();