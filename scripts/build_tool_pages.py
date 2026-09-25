"""Build the public, search-friendly tool pages (docs/<slug>.html), /tools, sitemap and rewrites.

Run from the repository root:  python scripts/build_tool_pages.py
Edit TOOLS below and re-run; every generated file is overwritten.
"""
from __future__ import annotations

import datetime as dt
import html
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DOCS = ROOT / "docs"
SITE = "https://www.nyxprism.com"
LOCAL = "Your PDF is processed right in your browser — it isn't uploaded to NyxPrism."
UPLOADED = ("The PDF is stored securely so each recipient can open it, and it is deleted automatically "
            "after the request expires. See the privacy policy for details.")

# slug, dashboard panel, name, search title, one-line description, pro?, local?, steps, features, extra FAQs, related
TOOLS = [
    dict(slug="split-pdf", panel="split", name="Split PDF", title="Split PDF Online — Extract Pages or Split by Range",
         desc="Split a PDF into several files by page range or every N pages, or pull out single pages.",
         steps=["Choose your PDF.", "Pick how to split: every N pages, custom ranges, or every page on its own.", "Download your new PDFs."],
         features=["Split by custom page ranges", "Split every N pages", "Extract every page as its own PDF", "Works in your browser"],
         related=["merge-pdf", "organize-pdf-pages", "ai-pdf-splitter"]),
    dict(slug="merge-pdf", panel="merge", name="Merge PDF", title="Merge PDF Files — Combine PDFs into One",
         desc="Combine several PDFs into a single document, in the order you choose.",
         steps=["Add two or more PDFs.", "Drag them into the order you want.", "Download the combined PDF."],
         features=["Combine any number of PDFs", "Reorder files before merging", "Keeps original quality", "Works in your browser"],
         related=["split-pdf", "compress-pdf", "organize-pdf-pages"]),
    dict(slug="compress-pdf", panel="compress", name="Compress PDF", title="Compress PDF — Reduce PDF File Size",
         desc="Shrink PDF file size so it's easier to email and upload. Works best on PDFs with images.",
         steps=["Choose your PDF.", "Pick a quality level.", "Download the smaller PDF."],
         features=["Adjustable quality", "Shows size before and after", "Batch compress many PDFs at once", "Works in your browser"],
         related=["batch-compress-pdf", "merge-pdf", "pdf-to-image"]),
    dict(slug="batch-compress-pdf", panel="batch", name="Batch Compress PDF", title="Batch Compress PDFs — Shrink Many PDFs at Once",
         desc="Compress many PDFs in one go and download them together as a ZIP file.",
         steps=["Add several PDFs.", "Choose a quality level.", "Download them all as a ZIP."],
         features=["Compress many files at once", "One ZIP download", "Optional ZIP password", "Works in your browser"],
         related=["compress-pdf", "merge-pdf", "split-pdf"]),
    dict(slug="rotate-pdf", panel="rotate", name="Rotate PDF", title="Rotate PDF Pages — Fix Sideways or Upside-Down Pages",
         desc="Rotate the whole document or just the pages that are sideways or upside down.",
         steps=["Choose your PDF.", "Pick the pages and the angle.", "Download the fixed PDF."],
         features=["Rotate all pages or specific ones", "90°, 180° or 270°", "Keeps everything else unchanged", "Works in your browser"],
         related=["organize-pdf-pages", "edit-pdf", "split-pdf"]),
    dict(slug="organize-pdf-pages", panel="pagemanager", name="Organize PDF Pages", title="Organize PDF Pages — Reorder and Delete Pages Visually",
         desc="Reorder, delete and rearrange pages with a visual drag-and-drop page view.",
         steps=["Choose your PDF.", "Drag pages into order and remove the ones you don't need.", "Download the reorganized PDF."],
         features=["Visual page thumbnails", "Drag-and-drop reordering", "Delete pages in one click", "Works in your browser"],
         related=["rotate-pdf", "split-pdf", "edit-pdf"]),
    dict(slug="edit-pdf", panel="editpdf", name="Edit PDF", title="Edit PDF Online — Delete, Reorder Pages and Add Text",
         desc="Delete or reorder pages and add text anywhere on a page.",
         steps=["Choose your PDF.", "Delete or reorder pages and place text where you need it.", "Download the edited PDF."],
         features=["Add text overlays", "Delete and reorder pages", "Preview as you edit", "Works in your browser"],
         related=["annotate-pdf", "organize-pdf-pages", "sign-pdf"]),
    dict(slug="annotate-pdf", panel="annotate", name="Annotate PDF", title="Annotate PDF — Highlight, Draw and Add Notes",
         desc="Highlight text, draw, add boxes and notes directly on your PDF pages.",
         steps=["Choose your PDF.", "Highlight, draw, add shapes or notes.", "Download the annotated PDF."],
         features=["Highlighter, pen, shapes and text", "Choose colours and line width", "Undo as you go", "Works in your browser"],
         related=["edit-pdf", "sign-pdf", "redact-pdf"]),
    dict(slug="sign-pdf", panel="sign", name="Sign PDF", title="Sign PDF Online — Draw, Type or Upload Your Signature",
         desc="Add your own signature to a PDF: draw it, type it or upload an image.",
         steps=["Choose your PDF.", "Draw, type or upload your signature and place it on the page.", "Download the signed PDF."],
         features=["Draw, type or upload a signature", "Place and resize it anywhere", "No account needed to open the result", "Works in your browser"],
         faqs=[("How do I get someone else to sign?", "Use Request Signatures to email a secure signing link to one or more people and track who has signed.")],
         related=["request-signatures", "annotate-pdf", "flatten-pdf"]),
    dict(slug="request-signatures", panel="signrequest", name="Request Signatures", title="Request Signatures — Send PDFs for E-Signature",
         desc="Email a PDF to one or more signers, in order, and get back a completed copy with a certificate of completion.",
         pro=True, local=False,
         steps=["Upload your PDF and add your signers.", "Place signature, date, name and other fields for each signer.", "Send — signers sign from any device, and everyone gets the completed PDF."],
         features=["Signers draw or type their signature", "Signing in order, one person after another", "Certificate of completion with a full audit trail", "Email when everyone has signed or someone declines"],
         faqs=[("Do signers need an account?", "No. Each signer gets a unique, secure link and can sign from any browser or phone."),
               ("What does the completed PDF include?", "Every signer's fields and a certificate page listing who signed, when, from which IP address, and SHA-256 fingerprints of the document.")],
         related=["sign-pdf", "send-pdf", "flatten-pdf"]),
    dict(slug="send-pdf", panel="distribution", name="Send PDF with Tracking", title="Send a PDF with Tracking — Know Who Opened It",
         desc="Send a PDF to one person or up to 250 at once, each with a private link, and see who opened it.",
         pro=True, local=False,
         steps=["Upload your PDF.", "Add recipients one by one or paste a list.", "Send, then track opens in your dashboard."],
         features=["Up to 250 recipients per send", "Paste a list of names and emails", "See who opened and when", "Revoke links at any time"],
         related=["request-signatures", "protect-pdf", "compress-pdf"]),
    dict(slug="protect-pdf", panel="protect", name="Protect PDF", title="Password Protect PDF — Encrypt a PDF with a Password",
         desc="Add a password to a PDF so only people who know it can open it.",
         steps=["Choose your PDF.", "Set an open password (and an optional owner password).", "Download the protected PDF."],
         features=["Password to open the file", "Optional owner password for permissions", "Encrypted in your browser", "Works with any PDF reader"],
         related=["redact-pdf", "watermark-pdf", "send-pdf"]),
    dict(slug="redact-pdf", panel="redact", name="Redact PDF", title="Redact PDF — Permanently Black Out Sensitive Information",
         desc="Permanently black out names, numbers and other sensitive details before you share a PDF.",
         steps=["Choose your PDF.", "Draw boxes over the text and images to hide.", "Download the redacted PDF."],
         features=["Covered content is removed, not just hidden", "Works on text and images", "Page-by-page preview", "Works in your browser"],
         related=["protect-pdf", "flatten-pdf", "watermark-pdf"]),
    dict(slug="watermark-pdf", panel="watermark", name="Watermark PDF", title="Watermark PDF — Add Text Like CONFIDENTIAL or DRAFT",
         desc="Stamp text such as CONFIDENTIAL or DRAFT across every page.",
         steps=["Choose your PDF.", "Type your watermark and adjust size, angle and opacity.", "Download the watermarked PDF."],
         features=["Custom text", "Adjustable opacity, size and angle", "Applied to every page", "Works in your browser"],
         related=["protect-pdf", "add-page-numbers-pdf", "pdf-header-footer"]),
    dict(slug="add-page-numbers-pdf", panel="number", name="Add Page Numbers", title="Add Page Numbers to PDF — Custom Position and Format",
         desc="Stamp page numbers on every page, with your choice of position, format and starting number.",
         steps=["Choose your PDF.", "Pick position, format, starting number and size.", "Download the numbered PDF."],
         features=["Six positions", "Formats like “Page 1 of 10”", "Custom starting number", "Works in your browser"],
         related=["pdf-header-footer", "watermark-pdf", "merge-pdf"]),
    dict(slug="pdf-header-footer", panel="headerfooter", name="PDF Header & Footer", title="Add Header and Footer to PDF",
         desc="Add header and footer text to every page, with automatic page numbers.",
         steps=["Choose your PDF.", "Type your header and footer text; use {page} and {total} for page numbers.", "Download the updated PDF."],
         features=["Header and footer text", "Automatic page numbers", "Applied to every page", "Works in your browser"],
         related=["add-page-numbers-pdf", "watermark-pdf", "edit-pdf-metadata"]),
    dict(slug="ocr-pdf", panel="ocr", name="OCR PDF", title="OCR PDF — Extract Text from Scanned PDFs",
         desc="Turn scanned pages and image-only PDFs into text you can copy and search.",
         steps=["Choose your scanned PDF.", "Pick the document language.", "Copy or download the extracted text."],
         features=["Reads scanned and photographed pages", "Multiple languages", "Copy or download as .txt", "Processed in your browser"],
         related=["extract-pdf-text", "ai-pdf-splitter", "pdf-to-image"]),
    dict(slug="extract-pdf-text", panel="extract", name="Extract PDF Text", title="Extract Text from PDF — Copy or Download as TXT",
         desc="Pull all readable text out of a PDF to copy or download.",
         steps=["Choose your PDF.", "Choose all pages or a range.", "Copy the text or download it as .txt."],
         features=["All pages or a page range", "Copy to clipboard", "Download as .txt", "Works in your browser"],
         faqs=[("What about scanned PDFs?", "Scanned pages are images, so use OCR PDF to read the text from them.")],
         related=["ocr-pdf", "pdf-to-image", "split-pdf"]),
    dict(slug="pdf-to-image", panel="convert", name="PDF to Image", title="PDF to Image and Image to PDF Converter",
         desc="Turn PDF pages into PNG or JPG images, or combine images into a single PDF.",
         steps=["Choose a PDF, or your images.", "Pick the image format and quality, or the page order.", "Download your images or the new PDF."],
         features=["PDF to PNG or JPG", "Images to a single PDF", "Adjustable resolution", "Works in your browser"],
         related=["compress-pdf", "ocr-pdf", "merge-pdf"]),
    dict(slug="flatten-pdf", panel="flatten", name="Flatten PDF", title="Flatten PDF — Lock Form Fields and Annotations",
         desc="Turn fillable form fields and annotations into static content that can't be changed.",
         steps=["Choose your PDF.", "Choose what to flatten.", "Download the flattened PDF."],
         features=["Flattens form fields", "Flattens annotations", "Prevents further edits in most readers", "Works in your browser"],
         related=["sign-pdf", "redact-pdf", "protect-pdf"]),
    dict(slug="compare-pdf", panel="diff", name="Compare PDF", title="Compare Two PDFs — Highlight Differences",
         desc="Compare two versions of a PDF side by side, with the differences highlighted in red.",
         steps=["Choose the original and the new version.", "Page through them side by side.", "Spot every change highlighted in red."],
         features=["Side-by-side view", "Pixel-level differences in red", "Page-by-page navigation", "Works in your browser"],
         related=["edit-pdf", "extract-pdf-text", "annotate-pdf"]),
    dict(slug="edit-pdf-metadata", panel="meta", name="Edit PDF Metadata", title="Edit PDF Metadata — Title, Author, Subject and Keywords",
         desc="View and change a PDF's title, author, subject, keywords and other details.",
         steps=["Choose your PDF.", "Edit the title, author, subject and keywords.", "Download the updated PDF."],
         features=["Title, author, subject, keywords", "Creator and producer fields", "See what's already set", "Works in your browser"],
         related=["pdf-header-footer", "protect-pdf", "compress-pdf"]),
    dict(slug="ai-pdf-splitter", panel="aisplit", name="AI PDF Splitter", title="AI PDF Splitter — Split PDFs by Describing What You Want",
         desc="Tell the AI how you want a PDF split — by chapter, by invoice, by person — and it plans and names the files for you.",
         pro=True, note="Your PDF file stays in your browser; only its text is sent to the AI to plan the split.",
         steps=["Choose your PDF.", "Describe how you want it split, in plain words.", "Review the plan and download the named files."],
         features=["Understands chapters, invoices, statements and more", "Suggests file names", "Revise the plan by chatting", "Your PDF file stays in your browser"],
         faqs=[("Is my document sent to the AI?", "The PDF file never leaves your browser. The extracted text is sent to the AI to plan the split, then discarded.")],
         related=["split-pdf", "ocr-pdf", "merge-pdf"]),
]
BY_SLUG = {t["slug"]: t for t in TOOLS}

CSS = """
:root{--bg:#06080d;--surface:#0f1724;--surface2:#141e2e;--border:#1b2840;--border2:#253548;--accent:#7c3aed;--accent-bright:#a78bfa;--text:#f0f4fc;--text2:#c8d3e0;--text3:#9aaec4;--green:#34d399}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font-family:Inter,system-ui,sans-serif;line-height:1.6}
a{color:var(--accent-bright)}.wrap{max-width:1040px;margin:0 auto;padding:0 clamp(1rem,4vw,2rem)}
header.top{border-bottom:1px solid var(--border);background:rgba(6,8,13,.8);backdrop-filter:blur(16px);position:sticky;top:0;z-index:5}
header.top .wrap{display:flex;align-items:center;gap:1rem;height:64px}.top nav{margin-left:auto;display:flex;gap:1rem;align-items:center;flex-wrap:wrap}
.top nav a{color:var(--text2);text-decoration:none;font-size:.9rem;font-weight:500}.top nav a.cta{background:var(--accent);color:#fff;padding:.45rem .9rem;border-radius:8px;font-weight:700}
.brand{display:flex;align-items:center;gap:.55rem;color:var(--text);text-decoration:none;font-weight:900;letter-spacing:-.02em}.brand img{width:32px;height:32px;border-radius:8px}.brand em{font-style:normal;color:var(--accent-bright)}
.hero{padding:3.5rem 0 2rem}.crumbs{font-size:.8rem;color:var(--text3);margin-bottom:.8rem}.crumbs a{color:var(--text3)}
h1{font-size:clamp(2rem,5vw,3rem);line-height:1.1;letter-spacing:-.03em;margin:0 0 .8rem}.lead{font-size:1.15rem;color:var(--text2);max-width:640px;margin:0 0 1.5rem}
.pill{display:inline-block;font-size:.72rem;font-weight:800;letter-spacing:.06em;text-transform:uppercase;padding:.25rem .6rem;border-radius:999px;background:rgba(124,58,237,.18);color:var(--accent-bright);margin-bottom:.9rem}
.btns{display:flex;gap:.75rem;flex-wrap:wrap}.btn{display:inline-block;padding:.8rem 1.3rem;border-radius:10px;font-weight:700;text-decoration:none;font-size:1rem}
.btn.primary{background:linear-gradient(135deg,var(--accent),#5b21b6);color:#fff}.btn.secondary{border:1px solid var(--border2);color:var(--text2);background:var(--surface)}
.note{font-size:.85rem;color:var(--text3);margin-top:.9rem}
section{padding:2rem 0}h2{font-size:1.5rem;letter-spacing:-.02em;margin:0 0 1rem}
.steps{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:1rem;list-style:none;padding:0;margin:0}
.steps li{background:var(--surface);border:1px solid var(--border);border-radius:14px;padding:1.1rem}.steps .n{width:30px;height:30px;border-radius:50%;background:var(--accent);color:#fff;display:grid;place-items:center;font-weight:800;margin-bottom:.6rem}
.features{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:.6rem;list-style:none;padding:0;margin:0}
.features li{padding:.7rem .9rem;border:1px solid var(--border);border-radius:10px;background:var(--surface)}.features li:before{content:"✓ ";color:var(--green);font-weight:800}
details{border:1px solid var(--border);border-radius:12px;background:var(--surface);padding:.9rem 1.1rem;margin-bottom:.6rem}summary{cursor:pointer;font-weight:700}details p{color:var(--text2);margin:.6rem 0 0}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:.75rem}
.card{display:block;text-decoration:none;color:var(--text);background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:1rem}.card:hover{border-color:var(--accent)}
.card strong{display:block;margin-bottom:.25rem}.card span{color:var(--text3);font-size:.86rem}
footer{border-top:1px solid var(--border);margin-top:2rem;padding:2rem 0;color:var(--text3);font-size:.85rem}footer .wrap{display:flex;gap:1.25rem;flex-wrap:wrap}footer a{color:var(--text3)}
"""


def page(title: str, description: str, path: str, body: str, schema: list[dict]) -> str:
    ld = "\n".join(f'<script type="application/ld+json">{json.dumps(s, ensure_ascii=False)}</script>' for s in schema)
    return f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>{html.escape(title)} | NyxPrism</title>
<meta name="description" content="{html.escape(description)}" />
<link rel="canonical" href="{SITE}{path}" />
<meta property="og:title" content="{html.escape(title)}" />
<meta property="og:description" content="{html.escape(description)}" />
<meta property="og:url" content="{SITE}{path}" />
<meta property="og:type" content="website" />
<meta name="theme-color" content="#7c3aed" />
<link rel="icon" href="/favicon.ico" />
<link rel="manifest" href="/manifest.json?v=5" />
<link rel="preconnect" href="https://fonts.googleapis.com" /><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=Inter:opsz,wght@14..32,400;14..32,500;14..32,700;14..32,800;14..32,900&display=swap" rel="stylesheet" />
<style>{CSS}</style>
{ld}
<script defer src="/_vercel/insights/script.js"></script>
</head>
<body>
<header class="top"><div class="wrap">
  <a class="brand" href="/"><img src="/prism-mark.webp?v=1" alt="" width="32" height="32" /><span><em>Nyx</em>Prism</span></a>
  <nav aria-label="Main"><a href="/tools">All tools</a><a href="/#pricing">Pricing</a><a href="/login.html">Log in</a><a class="cta" href="/login.html#trial">Start free</a></nav>
</div></header>
<main class="wrap">
{body}
</main>
<footer><div class="wrap"><span>© {dt.date.today().year} NyxCollective LLC</span><a href="/tools">All PDF tools</a><a href="/privacy.html">Privacy</a><a href="/terms.html">Terms</a><a href="/contact.html">Contact</a></div></footer>
</body>
</html>
"""


def tool_page(t: dict) -> str:
    pro = t.get("pro", False)
    local = t.get("local", True)
    open_url = f"/dashboard.html#{t['panel']}"
    signup_url = f"/login.html?next={t['panel']}#trial"
    faqs = [
        (f"Is {t['name']} free?",
         "It's included with NyxPrism Professional. Create a free account to get started, then upgrade when you're ready."
         if pro else "Yes. Create a free NyxPrism account and use it as often as you like."),
        ("Are my files uploaded?", (LOCAL if local else UPLOADED) if t["panel"] != "aisplit" else t["faqs"][0][1]),
        ("Does it work on Mac, Windows and phones?", "Yes. NyxPrism runs in any modern browser, and you can install it as an app on your computer."),
    ] + [f for f in t.get("faqs", []) if t["panel"] != "aisplit" or f[0] != "Is my document sent to the AI?"]
    steps = "".join(f'<li><div class="n">{i}</div>{html.escape(s)}</li>' for i, s in enumerate(t["steps"], 1))
    features = "".join(f"<li>{html.escape(f)}</li>" for f in t["features"])
    faq_html = "".join(f"<details><summary>{html.escape(q)}</summary><p>{html.escape(a)}</p></details>" for q, a in faqs)
    related = "".join(
        f'<a class="card" href="/{r}"><strong>{html.escape(BY_SLUG[r]["name"])}</strong><span>{html.escape(BY_SLUG[r]["desc"])}</span></a>'
        for r in t["related"])
    body = f"""<div class="hero">
  <div class="crumbs"><a href="/">Home</a> › <a href="/tools">PDF tools</a> › {html.escape(t['name'])}</div>
  {'<div class="pill">Professional</div>' if pro else ''}
  <h1>{html.escape(t['name'])}</h1>
  <p class="lead">{html.escape(t['desc'])}</p>
  <div class="btns"><a class="btn primary" href="{signup_url}">Try it free</a><a class="btn secondary" href="{open_url}">I have an account — open {html.escape(t['name'])}</a></div>
  <p class="note">{html.escape(t.get('note') or (LOCAL if local else 'Secure links, stored only as long as needed.'))}</p>
</div>
<section><h2>How it works</h2><ol class="steps">{steps}</ol></section>
<section><h2>What you get</h2><ul class="features">{features}</ul></section>
<section><h2>Questions</h2>{faq_html}</section>
<section><h2>Related tools</h2><div class="grid">{related}</div></section>"""
    schema = [
        {"@context": "https://schema.org", "@type": "SoftwareApplication", "name": f"NyxPrism {t['name']}",
         "applicationCategory": "BusinessApplication", "operatingSystem": "Web, Windows",
         "url": f"{SITE}/{t['slug']}", "description": t["desc"],
         "offers": {"@type": "Offer", "price": "12.00" if pro else "0", "priceCurrency": "USD"}},
        {"@context": "https://schema.org", "@type": "FAQPage", "mainEntity": [
            {"@type": "Question", "name": q, "acceptedAnswer": {"@type": "Answer", "text": a}} for q, a in faqs]},
        {"@context": "https://schema.org", "@type": "BreadcrumbList", "itemListElement": [
            {"@type": "ListItem", "position": 1, "name": "Home", "item": f"{SITE}/"},
            {"@type": "ListItem", "position": 2, "name": "PDF tools", "item": f"{SITE}/tools"},
            {"@type": "ListItem", "position": 3, "name": t["name"], "item": f"{SITE}/{t['slug']}"}]},
    ]
    return page(t["title"], t["desc"], f"/{t['slug']}", body, schema)


def tools_index() -> str:
    cards = "".join(
        f'<a class="card" href="/{t["slug"]}"><strong>{html.escape(t["name"])}{" · Pro" if t.get("pro") else ""}</strong><span>{html.escape(t["desc"])}</span></a>'
        for t in TOOLS)
    body = f"""<div class="hero"><h1>Every PDF tool, in one place</h1>
<p class="lead">Split, merge, compress, sign, protect, convert and more — most tools run right in your browser, so your files stay with you.</p>
<div class="btns"><a class="btn primary" href="/login.html#trial">Create a free account</a></div></div>
<section><div class="grid">{cards}</div></section>"""
    schema = [{"@context": "https://schema.org", "@type": "ItemList", "itemListElement": [
        {"@type": "ListItem", "position": i, "url": f"{SITE}/{t['slug']}", "name": t["name"]} for i, t in enumerate(TOOLS, 1)]}]
    return page("PDF Tools — Split, Merge, Compress, Sign and More", "All NyxPrism PDF tools: split, merge, compress, sign, protect, convert, OCR and more.", "/tools", body, schema)


def main() -> None:
    for t in TOOLS:
        (DOCS / f"{t['slug']}.html").write_text(tool_page(t), encoding="utf-8")
    (DOCS / "tools.html").write_text(tools_index(), encoding="utf-8")

    today = dt.date.today().isoformat()
    urls = [("/", "1.0"), ("/tools", "0.9")] + [(f"/{t['slug']}", "0.8") for t in TOOLS] + \
           [("/contact.html", "0.5"), ("/privacy.html", "0.3"), ("/terms.html", "0.3"), ("/login.html", "0.4")]
    sitemap = ['<?xml version="1.0" encoding="UTF-8"?>', '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">']
    sitemap += [f"  <url><loc>{SITE}{u}</loc><lastmod>{today}</lastmod><priority>{p}</priority></url>" for u, p in urls]
    sitemap.append("</urlset>")
    (DOCS / "sitemap.xml").write_text("\n".join(sitemap) + "\n", encoding="utf-8")

    vercel_path = ROOT / "vercel.json"
    vercel = json.loads(vercel_path.read_text(encoding="utf-8"))
    generated = {f"/{t['slug']}" for t in TOOLS} | {"/tools"}
    kept = [r for r in vercel.get("rewrites", []) if r["source"] not in generated]
    vercel["rewrites"] = kept + [{"source": s, "destination": f"{s}.html"} for s in sorted(generated)]
    vercel_path.write_text(json.dumps(vercel, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"Built {len(TOOLS)} tool pages, /tools, sitemap ({len(urls)} URLs) and rewrites.")


if __name__ == "__main__":
    main()
