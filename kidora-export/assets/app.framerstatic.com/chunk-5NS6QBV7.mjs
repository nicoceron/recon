function n(){let{activeElement:e}=document;if(e instanceof HTMLIFrameElement&&e.contentWindow)try{e=e.contentWindow.document.activeElement}catch(t){if(t instanceof DOMException)return!0;throw t}return e?e.nodeName==="INPUT"||e.nodeName==="TEXTAREA"||e.isContentEditable:!1}export{n as a};
//# sourceMappingURL=/assets/app.framerstatic.com/chunk-5NS6QBV7.mjs.map
