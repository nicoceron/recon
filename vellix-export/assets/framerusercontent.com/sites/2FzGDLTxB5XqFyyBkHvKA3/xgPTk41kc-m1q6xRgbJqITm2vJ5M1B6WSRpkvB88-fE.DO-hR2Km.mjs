import{t as e}from"./rolldown-runtime.uxh0A31G.mjs";import{$ as t,C as n,Y as r}from"./framer.CKRLuTqG.mjs";async function i(e,t,n){let r=d[e],i=r?await r(t,n):void 0,a={bodyEnd:[],bodyStart:[],headEnd:[],headStart:[]};for(let t of l){if(t.pageIds&&!t.pageIds.has(e))continue;let n=t.code(i);n&&a[t.placement].push({...t,code:n})}return a}var a,o,s,c,l,u,d,f,p;e((()=>{t(),a=e=>typeof e==`string`?e.replaceAll(`&`,`&amp;`).replaceAll(`<`,`&lt;`).replaceAll(`>`,`&gt;`).replaceAll(`"`,`&quot;`).replaceAll(`'`,`&#39;`):``,o=e=>typeof e==`string`?e:String(e),s=e=>{let t=JSON.stringify(e);return typeof t==`string`?t.replace(/<\/(script|style)/gi,`<\\/$1`):t},c=e=>typeof e==`object`&&e&&typeof e.src==`string`?e.src:typeof e==`string`?e:void 0,l=[{code:e=>`<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "Organization",
      "@id": "https://vellix.framer.ai/#organization",
      "name": "Vellix",
      "description": "Turn Manual Work Into Autonomous Revenue Systems",
      "url": "https://vellix.framer.ai/",
      "sameAs": [
        "https://x.com/kaniyanstudio"
      ]
    },
    {
      "@type": "WebSite",
      "@id": "https://vellix.framer.ai/#website",
      "name": "Vellix",
      "url": "https://vellix.framer.ai/",
      "publisher": {
        "@id": "https://vellix.framer.ai/#organization"
      }
    },
    {
      "@type": "WebPage",
      "@id": "https://vellix.framer.ai/#webpage",
      "name": "Turn Manual Work Into Autonomous Revenue Systems",
      "description": "We design and deploy AI systems that replace repetitive workflows, capture more leads, and increase revenue without adding headcount.",
      "url": "https://vellix.framer.ai/",
      "isPartOf": {
        "@id": "https://vellix.framer.ai/#website"
      },
      "about": {
        "@id": "https://vellix.framer.ai/#organization"
      }
    }
  ]
}
<\/script>`,id:`jgoIofKgU`,loadMode:`once`,name:`Home Page JSON-LD`,pageIds:new Set([`augiA20Il`]),placement:`headStart`},{code:e=>`<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "ContactPage",
  "name": "Contact Vellix",
  "url": "https://vellix.framer.ai/contact",
  "description": "Contact Vellix for AI automation support, workflow systems, and general inquiries.",
  "mainEntity": {
    "@type": "ContactPoint",
    "contactType": "customer support",
    "email": "kaniyanahmad1@gmail.com",
    "availableLanguage": ["English"]
  }
}
<\/script>`,id:`STR7B2noo`,loadMode:`once`,name:`Contact JSON-LD`,pageIds:new Set([`zxMNn_28w`]),placement:`headStart`},{code:e=>`<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "CollectionPage",
      "@id": "https://vellix.framer.ai/case-studies",
      "url": "https://vellix.framer.ai/case-studies",
      "name": "Real Systems. Real Results.",
      "description": "Explore selected case studies and results from our client projects.",
      "headline": "Real Systems. Real Results.",
      "alternativeHeadline": "See how companies are scaling with AI-driven workflows.",
      "isPartOf": {
        "@type": "WebSite",
        "name": "Vellix",
        "url": "https://vellix.framer.ai"
      },
      "breadcrumb": {
        "@id": "https://vellix.framer.ai/case-studies#breadcrumb"
      }
    },
    {
      "@type": "BreadcrumbList",
      "@id": "https://vellix.framer.ai/case-studies#breadcrumb",
      "itemListElement": [
        {
          "@type": "ListItem",
          "position": 1,
          "name": "Home",
          "item": "https://vellix.framer.ai"
        },
        {
          "@type": "ListItem",
          "position": 2,
          "name": "Case Studies",
          "item": "https://vellix.framer.ai/case-studies"
        }
      ]
    }
  ]
}
<\/script>`,id:`faVtp4wKP`,loadMode:`once`,name:`Case Studies JSON-LD`,pageIds:new Set([`wfDuABBjt`]),placement:`headStart`},{code:e=>{let t=e?.ABTuRgtUz??``,n=e?.bgZUygsEG??``,r=e?.Ydcjx_KBd??``,i=e?.createdAt,l=e?.updatedAt,u=e?.lrD85YARH;return`<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "WebPage",
      "@id": "https://vellix.framer.ai/case-studies/${t===void 0?`{{ABTuRgtUz}}`:o(a(t))}#webpage",
      "url": "https://vellix.framer.ai/case-studies/${t===void 0?`{{ABTuRgtUz}}`:o(a(t))}",
      "name": ${n===void 0?`{{bgZUygsEG | json}}`:o(s(a(n)))},
      "description": ${r===void 0?`{{Ydcjx_KBd | json}}`:o(s(a(r)))},
      "datePublished": ${i===void 0?`{{createdAt | json}}`:o(s(a(i)))},
      "dateModified": ${l===void 0?`{{updatedAt | json}}`:o(s(a(l)))},
      "isPartOf": {
        "@type": "CollectionPage",
        "@id": "https://vellix.framer.ai/case-studies"
      },
      "primaryImageOfPage": {
        "@type": "ImageObject",
        "url": ${u===void 0?`{{lrD85YARH | json}}`:o(s(a(c(u))))}
      }
    },
    {
      "@type": "BreadcrumbList",
      "@id": "https://vellix.framer.ai/case-studies/${t===void 0?`{{ABTuRgtUz}}`:o(a(t))}#breadcrumb",
      "itemListElement": [
        {
          "@type": "ListItem",
          "position": 1,
          "name": "Home",
          "item": "https://vellix.framer.ai"
        },
        {
          "@type": "ListItem",
          "position": 2,
          "name": "Case Studies",
          "item": "https://vellix.framer.ai/case-studies"
        },
        {
          "@type": "ListItem",
          "position": 3,
          "name": ${n===void 0?`{{bgZUygsEG | json}}`:o(s(a(n)))},
          "item": "https://vellix.framer.ai/case-studies/${t===void 0?`{{ABTuRgtUz}}`:o(a(t))}"
        }
      ]
    }
  ]
}
<\/script>`},id:`EP8RtO2_x`,loadMode:`once`,name:`Case Studies Post JSON-LD`,pageIds:new Set([`nQo7Wjt4c`]),placement:`headStart`},{code:e=>`<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "CollectionPage",
      "@id": "https://vellix.framer.ai/blog",
      "url": "https://vellix.framer.ai/blog",
      "name": "AI Automation Blog",
      "description": "Insights, strategies, and guides on AI automation, workflow systems, lead generation, and scalable business operations.",
      "headline": "AI Automation Blog",
      "alternativeHeadline": "Learn how AI systems streamline workflows and grow businesses.",
      "isPartOf": {
        "@type": "WebSite",
        "name": "Vellix",
        "url": "https://vellix.framer.ai"
      },
      "breadcrumb": {
        "@id": "https://vellix.framer.ai/blog#breadcrumb"
      }
    },
    {
      "@type": "BreadcrumbList",
      "@id": "https://vellix.framer.ai/blog#breadcrumb",
      "itemListElement": [
        {
          "@type": "ListItem",
          "position": 1,
          "name": "Home",
          "item": "https://vellix.framer.ai"
        },
        {
          "@type": "ListItem",
          "position": 2,
          "name": "Blog",
          "item": "https://vellix.framer.ai/blog"
        }
      ]
    }
  ]
}
<\/script>`,id:`A6VDkLaqp`,loadMode:`once`,name:`Blog JSON-LD`,pageIds:new Set([`tkCsCVUWR`]),placement:`headStart`},{code:e=>{let t=e?.R8P96417E??``,n=e?.Z5L_W7KgH??``,r=e?.E3T77Sf5y??``,i=e?.createdAt,c=e?.updatedAt,l=e?.ZfhlrQzwC??``;return`<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "BlogPosting",
      "@id": "https://vellix.framer.ai/blog/${t===void 0?`{{R8P96417E}}`:o(a(t))}#blogposting",
      "mainEntityOfPage": {
        "@type": "WebPage",
        "@id": "https://vellix.framer.ai/blog/${t===void 0?`{{R8P96417E}}`:o(a(t))}"
      },
      "headline": ${n===void 0?`{{Z5L_W7KgH | json}}`:o(s(a(n)))},
      "description": ${r===void 0?`{{E3T77Sf5y | json}}`:o(s(a(r)))},
      "datePublished": ${i===void 0?`{{createdAt | json}}`:o(s(a(i)))},
      "dateModified": ${c===void 0?`{{updatedAt | json}}`:o(s(a(c)))},
      "author": {
        "@type": "Person",
        "name": ${l===void 0?`{{ZfhlrQzwC | json}}`:o(s(a(l)))}
      },
      "publisher": {
        "@type": "Organization",
        "name": "Vellix",
        "url": "https://vellix.framer.ai"
      }
    },
    {
      "@type": "BreadcrumbList",
      "@id": "https://vellix.framer.ai/blog/${t===void 0?`{{R8P96417E}}`:o(a(t))}#breadcrumb",
      "itemListElement": [
        {
          "@type": "ListItem",
          "position": 1,
          "name": "Home",
          "item": "https://vellix.framer.ai"
        },
        {
          "@type": "ListItem",
          "position": 2,
          "name": "Blog",
          "item": "https://vellix.framer.ai/blog"
        },
        {
          "@type": "ListItem",
          "position": 3,
          "name": ${n===void 0?`{{Z5L_W7KgH | json}}`:o(s(a(n)))},
          "item": "https://vellix.framer.ai/blog/${t===void 0?`{{R8P96417E}}`:o(a(t))}"
        }
      ]
    }
  ]
}
<\/script>`},id:`kv7qwf5Y9`,loadMode:`once`,name:`Blog Post JSON-LD`,pageIds:new Set([`ndpoHgOJN`]),placement:`headStart`},{code:e=>{let t=e?.fk0XNXX91??``,n=e?.vLXWUjhSV??``,r=e?.c51FY0WDv,i=e?.createdAt,c=e?.updatedAt;return`<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "WebPage",
      "@id": "https://vellix.framer.ai/legal/${t===void 0?`{{fk0XNXX91}}`:o(a(t))}#webpage",
      "url": "https://vellix.framer.ai/legal/${t===void 0?`{{fk0XNXX91}}`:o(a(t))}",
      "name": ${n===void 0?`{{vLXWUjhSV | json}}`:o(s(a(n)))},
      "description": ${n===void 0?`{{vLXWUjhSV | json}}`:o(s(a(n)))},
      "dateCreated": ${r===void 0?`{{c51FY0WDv | json}}`:o(s(a(r)))},
      "datePublished": ${i===void 0?`{{createdAt | json}}`:o(s(a(i)))},
      "dateModified": ${c===void 0?`{{updatedAt | json}}`:o(s(a(c)))},
      "isPartOf": {
        "@type": "WebSite",
        "@id": "https://vellix.framer.ai/#website",
        "name": "Vellix",
        "url": "https://vellix.framer.ai/"
      },
      "publisher": {
        "@type": "Organization",
        "@id": "https://vellix.framer.ai/#organization",
        "name": "Vellix",
        "url": "https://vellix.framer.ai/"
      }
    },
    {
      "@type": "BreadcrumbList",
      "@id": "https://vellix.framer.ai/legal/${t===void 0?`{{fk0XNXX91}}`:o(a(t))}#breadcrumb",
      "itemListElement": [
        {
          "@type": "ListItem",
          "position": 1,
          "name": "Home",
          "item": "https://vellix.framer.ai/"
        },
        {
          "@type": "ListItem",
          "position": 2,
          "name": "Legal",
          "item": "https://vellix.framer.ai/legal"
        },
        {
          "@type": "ListItem",
          "position": 3,
          "name": ${n===void 0?`{{vLXWUjhSV | json}}`:o(s(a(n)))},
          "item": "https://vellix.framer.ai/legal/${t===void 0?`{{fk0XNXX91}}`:o(a(t))}"
        }
      ]
    }
  ]
}
<\/script>`},id:`k_OjDzKnY`,loadMode:`once`,name:`Legal Pages JSON-LD`,pageIds:new Set([`DFOBtPQ6L`]),placement:`headStart`}],u=new n,d={DFOBtPQ6L:async(e,t)=>{let n={from:{alias:`DFOBtPQ6L`,data:(await import(`./NvtaWGQBdfO4WquGPXvc68Gdr3EoAlgsGlyXX946yxw.lZRY26nz.mjs`)).default,type:`Collection`},select:[{collection:`DFOBtPQ6L`,name:`fk0XNXX91`,type:`Identifier`},{collection:`DFOBtPQ6L`,name:`vLXWUjhSV`,type:`Identifier`},{collection:`DFOBtPQ6L`,name:`c51FY0WDv`,type:`Identifier`},{collection:`DFOBtPQ6L`,name:`createdAt`,type:`Identifier`},{collection:`DFOBtPQ6L`,name:`updatedAt`,type:`Identifier`}],where:r(e,`DFOBtPQ6L`)},i=await u.query(n,t);if(i.length===0)throw Error(`No data matches pathVariables`);return i[0]},ndpoHgOJN:async(e,t)=>{let n={from:{alias:`ndpoHgOJN`,data:(await import(`./39i7Ng6fp5IsVksXCQg17qhr0nLxK6X40KDzvVLPGeM.DX2Liu09.mjs`)).default,type:`Collection`},select:[{collection:`ndpoHgOJN`,name:`R8P96417E`,type:`Identifier`},{collection:`ndpoHgOJN`,name:`Z5L_W7KgH`,type:`Identifier`},{collection:`ndpoHgOJN`,name:`E3T77Sf5y`,type:`Identifier`},{collection:`ndpoHgOJN`,name:`createdAt`,type:`Identifier`},{collection:`ndpoHgOJN`,name:`updatedAt`,type:`Identifier`},{collection:`ndpoHgOJN`,name:`ZfhlrQzwC`,type:`Identifier`}],where:r(e,`ndpoHgOJN`)},i=await u.query(n,t);if(i.length===0)throw Error(`No data matches pathVariables`);return i[0]},nQo7Wjt4c:async(e,t)=>{let n={from:{alias:`nQo7Wjt4c`,data:(await import(`./JKc5L7SQyQUJJLksSw6y8XTZ1PUgywPQPskNiLa2x4I.QRvRbVVw.mjs`)).default,type:`Collection`},select:[{collection:`nQo7Wjt4c`,name:`ABTuRgtUz`,type:`Identifier`},{collection:`nQo7Wjt4c`,name:`bgZUygsEG`,type:`Identifier`},{collection:`nQo7Wjt4c`,name:`Ydcjx_KBd`,type:`Identifier`},{collection:`nQo7Wjt4c`,name:`createdAt`,type:`Identifier`},{collection:`nQo7Wjt4c`,name:`updatedAt`,type:`Identifier`},{collection:`nQo7Wjt4c`,name:`lrD85YARH`,type:`Identifier`}],where:r(e,`nQo7Wjt4c`)},i=await u.query(n,t);if(i.length===0)throw Error(`No data matches pathVariables`);return i[0]}},f={bodyEnd:[],bodyStart:[],headEnd:[],headStart:[`jgoIofKgU`,`STR7B2noo`,`faVtp4wKP`,`EP8RtO2_x`,`A6VDkLaqp`,`kv7qwf5Y9`,`k_OjDzKnY`]},p={exports:{snippetsSorting:{type:`variable`,annotations:{framerContractVersion:`1`}},getSnippets:{type:`function`,annotations:{framerContractVersion:`1`}},__FramerMetadata__:{type:`variable`}}}}))();export{p as __FramerMetadata__,i as getSnippets,f as snippetsSorting};
//# sourceMappingURL=xgPTk41kc-m1q6xRgbJqITm2vJ5M1B6WSRpkvB88-fE.DO-hR2Km.mjs.map