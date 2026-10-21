import {createHash,randomUUID} from 'node:crypto';
export function createBaiduTranslator({appId,secret,fetcher=fetch}){
  if(!appId||!secret)throw new Error('Baidu translation credentials are incomplete.');
  return async(text,isKorean)=>{
    const salt=randomUUID();const sign=createHash('md5').update(appId+text+salt+secret,'utf8').digest('hex');
    const params=new URLSearchParams({q:text,from:isKorean?'kor':'zh',to:isKorean?'zh':'kor',appid:appId,salt,sign});
    let result;
    try{const response=await fetcher('https://fanyi-api.baidu.com/api/trans/vip/translate',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:params,signal:AbortSignal.timeout(12000)});if(!response.ok)throw new Error('Unavailable');result=await response.json();}
    catch{throw Object.assign(new Error('暂时连接不上查词服务，请重试或手动填写。'),{status:502});}
    if(result.error_code)throw Object.assign(new Error('查词服务暂不可用，请重试或手动填写。'),{status:502});
    if(!Array.isArray(result.trans_result)||typeof result.trans_result[0]?.dst!=='string')throw Object.assign(new Error('没有查到合适的释义，请手动确认。'),{status:422});
    return result.trans_result.map(row=>row.dst).join('；');
  };
}
