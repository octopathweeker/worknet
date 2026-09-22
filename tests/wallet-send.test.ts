import assert from 'node:assert/strict';
import {test} from 'node:test';
import {walletSendFailure,resetUnsentWalletJournal,UnbroadcastTransactionError} from '../apps/explorer/src/wallet-send.js';

test('only definite nested wallet rejections release the send lock; ambiguous RPC failures do not',()=>{
 assert.equal(walletSendFailure({name:'TransactionExecutionError',cause:{name:'InsufficientFundsError',message:'The total cost exceeds the balance'}}),'insufficient-funds');
 assert.equal(walletSendFailure({code:-32603,data:{originalError:{code:-32000,message:'insufficient funds for gas * price + value'}}}),'insufficient-funds');
 assert.equal(walletSendFailure({cause:{code:4001,message:'User rejected the request'}}),'rejected');
 for(const message of ['request timeout','Failed to fetch','nonce too low','already known','transaction underpriced'])assert.equal(walletSendFailure(new Error(message)),undefined);
 const cycle:any={};cycle.cause=cycle;assert.equal(walletSendFailure(cycle),undefined);
 assert.equal(walletSendFailure(new UnbroadcastTransactionError(new Error('SESSION_ENDED'))),'not-sent');
 assert.equal(walletSendFailure({name:'UnbroadcastTransactionError',message:'RPC supplied this name'}),undefined);
 assert.equal(walletSendFailure(new UnbroadcastTransactionError({code:4001})),'rejected');
});

test('legacy unsent recovery requires wallet confirmation, no hash and no pending nonce',()=>{
 assert.throws(()=>resetUnsentWalletJournal({sending:true},false,false),/钱包/);
 assert.throws(()=>resetUnsentWalletJournal({sending:true,hash:'0x1234'},true,false),/hash/);
 assert.throws(()=>resetUnsentWalletJournal({sending:true},true,true),/待处理/);
 const reset=resetUnsentWalletJournal({sending:true,failure:'legacy'},true,false);
 assert.equal(reset.sending,false);assert.equal(reset.failure,'legacy');assert.equal(reset.resetReason,'owner-confirmed-not-sent');
});
