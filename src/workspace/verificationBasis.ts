import {modelHash,hashValue} from '../core/export';
import {reviewSchema,moduleReviewsSchema,type Model} from '../core/schema';
import {reviewState} from '../core/reviewImpact';
import {validateModel} from '../core/engine';
import {inputFile} from './artifacts';

/** A derived snapshot, never a second authority or an approval writer. */
export async function verificationBasis(workspace:string,model:Model){
 const hash=modelHash(model),origin=model.provenance?.origin??'unknown';
 const optional=async(file:string)=>{try{return JSON.parse((await inputFile(workspace,file)).bytes.toString());}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return undefined;throw e;}};
 try{
  const raw=await optional('architecture/review.json'),review=raw===undefined?undefined:reviewSchema.parse(raw),records=moduleReviewsSchema.parse(await optional('architecture/module-reviews.json')??{schemaVersion:1,modules:{}}),state=reviewState(model,hash,review,records);
  const approved=state.reviewStatus==='APPROVED'&&!validateModel(model).some(i=>i.blocks.includes('review'));
  return {modelHash:hash,kind:origin==='as_built'?'as_built':origin==='design'&&approved?'approved_intent':origin==='design'?'unreviewed_design':'unknown',origin,reviewStatus:state.reviewStatus,reviewRecordHash:hashValue({review:review??null,records}),review:review??null};
 }catch{
  return {modelHash:hash,kind:origin==='as_built'?'as_built':'unknown',origin,reviewStatus:'UNKNOWN',reviewRecordHash:null,review:null};
 }
}
