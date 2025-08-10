export function normCdf(x){return (1.0+erf(x/Math.SQRT2))/2.0}
export function normPdf(x){return Math.exp(-0.5*x*x)/Math.sqrt(2*Math.PI)}
export function erf(x){
  const a1=0.254829592,a2=-0.284496736,a3=1.421413741,a4=-1.453152027,a5=1.061405429,p=0.3275911;
  const sign=x<0?-1:1; x=Math.abs(x); const t=1/(1+p*x);
  const y=1-((((a5*t+a4)*t+a3)*t+a2)*t+a1)*t*Math.exp(-x*x);
  return sign*y;
}
export function d1(S,K,r,vol,t){return (Math.log(S/K)+(r+0.5*vol*vol)*t)/(vol*Math.sqrt(t))}
export function d2(S,K,r,vol,t){return d1(S,K,r,vol,t)-vol*Math.sqrt(t)}
export function bsPrice(S,K,r,vol,t,type='C'){
  if(t<=0||vol<=0){const intrinsic=type==='C'?Math.max(0,S-K):Math.max(0,K-S);return intrinsic}
  const D1=d1(S,K,r,vol,t),D2=d2(S,K,r,vol,t)
  return type==='C'? S*normCdf(D1)-K*Math.exp(-r*t)*normCdf(D2) : K*Math.exp(-r*t)*normCdf(-D2)-S*normCdf(-D1)
}
export function greeks(S,K,r,vol,t,type='C'){
  const D1=d1(S,K,r,vol,t),D2=d2(S,K,r,vol,t),pdf=normPdf(D1)
  const delta=type==='C'?normCdf(D1):(normCdf(D1)-1)
  const gamma=pdf/(S*vol*Math.sqrt(t))
  const vega=S*pdf*Math.sqrt(t)
  const thetaC=-(S*pdf*vol)/(2*Math.sqrt(t))-r*K*Math.exp(-r*t)*normCdf(D2)
  const thetaP=-(S*pdf*vol)/(2*Math.sqrt(t))+r*K*Math.exp(-r*t)*normCdf(-D2)
  const theta=type==='C'?thetaC:thetaP
  const rhoC=K*t*Math.exp(-r*t)*normCdf(D2)
  const rhoP=-K*t*Math.exp(-r*t)*normCdf(-D2)
  const rho=type==='C'?rhoC:rhoP
  return {delta,gamma,vega,theta,rho}
}
export function impliedVol(target,S,K,r,t,type='C',guess=0.2){
  if(target<=0) return 0.0001
  let vol=guess
  for(let i=0;i<100;i++){
    const price=bsPrice(S,K,r,vol,t,type), { vega }=greeks(S,K,r,vol,t,type), diff=price-target
    if(Math.abs(diff)<1e-6) return vol
    const step=diff/Math.max(1e-8,vega); vol-=step; if(vol<=0||vol>5) break
  }
  let lo=1e-6,hi=5
  for(let i=0;i<80;i++){const mid=(lo+hi)/2,price=bsPrice(S,K,r,mid,t,type); if(price>target)hi=mid;else lo=mid}
  return (lo+hi)/2
}
