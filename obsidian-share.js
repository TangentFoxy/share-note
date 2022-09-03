const HOST = 'https://example.com'
const YAML_FIELD = 'share'
const SECRET = 'some_fancy_secret'
const WIDTH = 720

const fs = require('fs')
const leaf = app.workspace.activeLeaf
const startMode = leaf.getViewState()

// Switch to Preview mode
const previewMode = leaf.getViewState()
previewMode.state.mode = 'preview'
leaf.setViewState(previewMode)
await new Promise(resolve => { setTimeout(() => { resolve() }, 200) })

// Parse the current document
let content, body, previewView, css
try {
    content = leaf.view.modes.preview.renderer.sections.reduce((p, c) => p + c.el.innerHTML, '')
    body = document.getElementsByTagName('body')[0]
    previewView = document.getElementsByClassName('markdown-preview-view markdown-rendered')[0]
    css = [...document.styleSheets].map(x => {
        try { return [...x.cssRules].map(rule => rule.cssText).join('') }
        catch (e) { }
    }).filter(Boolean).join('\n').replace(/\s{2,}/g, ' ')
} catch (e) {
    console.log(e)
    new Notice('Failed to parse current note, check console for details', 5000)
}

// Revert to the original view mode
setTimeout(() => {
    leaf.setViewState(startMode)
}, 200)

if (!previewView) {
    // Failed to parse current note
    return
}

async function sha256(text) {
    const encoder = new TextEncoder();
    const data = encoder.encode(text)
    const hash = await crypto.subtle.digest('SHA-256', data)
    return Array.from(new Uint8Array(hash)).map((b) => b.toString(16).padStart(2, '0')).join('')
}
const getHash = async (path) => { return (await sha256(path)).slice(0, 32) }

function updateFrontmatter(contents, field, value) {
    const f = contents.match(/^---\r?\n(.*?)\n---\r?\n(.*)$/s),
        v = `${field}: ${value}`,
        x = new RegExp(`^${field}:.*$`, 'm'),
        [s, e] = f ? [`${f[1]}\n`, f[2]] : ['', contents]
    return f && f[1].match(x) ? contents.replace(x, v) : `---\n${s}${v}\n---\n${e}`
}

async function upload(data) {
    data.nonce = Date.now().toString()
    data.auth = await sha256(data.nonce + SECRET)
    await requestUrl({ url: HOST + '/upload.php', method: 'POST', body: JSON.stringify(data) })
}

const file = app.workspace.getActiveFile()
let html = `
<!DOCTYPE HTML>
<html>
<head>
    <title>${file.basename}</title>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <link rel="stylesheet" href="style.css">
</head>
<body class="${body.className}" style="${body.style.cssText.replace(/"/g, `'`)}">
<div class="app-container">
<div class="horizontal-main-container">
<div class="workspace">
<div class="workspace-split mod-vertical mod-root">
<div class="workspace-leaf mod-active">
<div class="workspace-leaf-content">
<div class="view-content">
<div class="markdown-reading-view" style="max-width:${WIDTH}px;margin: 0 auto;">
<div class="${previewView.className}">
<div class="markdown-preview-sizer markdown-preview-section">
${content}
</div></div></div></div></div></div></div></div></div></body></html>`

try {
    // Generate the HTML file for uploading
    const dom = new DOMParser().parseFromString(html, 'text/html')
    // Remove frontmatter to avoid sharing unwanted data
    dom.querySelector('pre.frontmatter')?.remove()
    dom.querySelector('div.frontmatter-container')?.remove()
    // Replace links
    for (const el of dom.querySelectorAll("a.internal-link")) {
        const file = app.metadataCache.getFirstLinkpathDest(el.getAttribute('href'), '')
        const meta = app.metadataCache.getFileCache(file)
        if (meta?.frontmatter && meta.frontmatter[YAML_FIELD + '_link']) {
            // This file is shared, so update the link with the share URL
            el.setAttribute('href', meta.frontmatter[YAML_FIELD + '_link'])
            el.removeAttribute('target')
        } else {
            // This file is not shared, so remove the link
            el.replaceWith(el.innerHTML)
        }
    }
    // Upload local images
    for (const el of dom.querySelectorAll('img')) {
        const src = el.getAttribute('src')
        if (!src.startsWith('app://')) continue
        try {
            const localFile = window.decodeURIComponent(src.match(/app:\/\/local\/([^?#]+)/)[1])
            const url = (await getHash(localFile)) + '.' + localFile.split('.').pop()
            el.setAttribute('src', url)
            el.removeAttribute('alt')
            upload({ filename: url, content: fs.readFileSync(localFile, { encoding: 'base64' }), encoding: 'base64' })
        } catch (e) {
            console.log(e)
        }
    }
    // Share the file
    const shareFile = (await getHash(file.path)) + '.html'
    upload({ filename: shareFile, content: dom.documentElement.innerHTML })
    upload({ filename: 'style.css', content: css })
    let contents = await app.vault.read(file)
    contents = updateFrontmatter(contents, YAML_FIELD + '_updated', moment().format())
    contents = updateFrontmatter(contents, YAML_FIELD + '_link', `${HOST}/${shareFile}`)
    app.vault.modify(file, contents)
    new Notice('File has been shared', 5000)
} catch (e) {
    console.log(e)
    new Notice('Failed to share file', 5000)
}