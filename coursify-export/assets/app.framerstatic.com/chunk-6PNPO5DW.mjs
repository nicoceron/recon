function s(i,...n){if(i)return;let t=Error("Assertion Error"+(n.length>0?": "+n.join(" "):""));if(t.stack)try{let e=t.stack.split(`
`);e[1]?.includes("assert")?(e.splice(1,1),t.stack=e.join(`
`)):e[0]?.includes("assert")&&(e.splice(0,1),t.stack=e.join(`
`))}catch{}throw t}function r(i,n){throw n instanceof Error?n:n!==void 0?new Error(String(n)):new Error(i?`Unexpected value: ${i}`:"Application entered invalid state")}export{s as a,r as b};
//# sourceMappingURL=/assets/app.framerstatic.com/chunk-6PNPO5DW.mjs.map
