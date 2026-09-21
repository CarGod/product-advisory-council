/* Offline chat image/PDF export. Native browser APIs only; no network or dependencies. */
(() => {
  'use strict';
  const WIDTH = 540, SCALE = 2, MAX_PIXELS = 16000000, MAX_PAGES = 80;
  const urls = new Set();
  let busy = false;
  const tick = () => new Promise(resolve => requestAnimationFrame(resolve));
  const objectURL = blob => { const url = URL.createObjectURL(blob); urls.add(url); return url; };
  function clearURLs() { for (const url of urls) URL.revokeObjectURL(url); urls.clear(); }

  function save(url, name) { const a = document.createElement('a'); a.href = url; a.download = name; document.body.append(a); a.click(); a.remove(); }
  const filename = () => (DATA.chat.topic || '产品顾问团').replace(/[\\/:*?"<>|\x00-\x1f]/g, '-').slice(0, 60);

  // Choose complete messages first. Only split an oversized message at a safe
  // gap between rendered text lines. Coordinates cover [0, height] exactly.
  function planPages(height, capacity, boundaries, safeGaps) {
    const pages = []; let start = 0;
    const latest = (points, low, high) => points.filter(y => y > low + .1 && y <= high).pop();
    while (start < height - .1) {
      const limit = Math.min(height, start + capacity);
      let end = limit === height ? height : latest(boundaries, start, limit);
      const followingBoundary = end == null ? null : boundaries.find(y => y > end);
      const sparseBeforeOversized = end != null && end-start < capacity*.45 && followingBoundary != null && followingBoundary-end > capacity;
      if (end == null || sparseBeforeOversized) {
        const originalEnd = end;
        const nextBoundary = sparseBeforeOversized ? followingBoundary : boundaries.find(y => y > limit) || height;
        const span = nextBoundary-start, pieces = Math.ceil(span/capacity);
        // Balance an oversized message so the final page is not one orphan line.
        const balancedLimit = start + span/pieces;
        end = latest(safeGaps, start, Math.min(limit, balancedLimit));
        if (end == null) end = latest(safeGaps, start, limit);
        if (originalEnd != null && (end == null || end < originalEnd)) end = originalEnd;
      }
      if (end == null || end <= start) throw new Error('存在超出一页且无法安全断开的内容，请改选更长的比例或单张长图。');
      pages.push({start, end}); start = end;
      if (pages.length > MAX_PAGES) throw new Error('内容超过 80 张，请先缩小讨论范围再导出。');
    }
    return pages;
  }

  // Starts include the date label immediately before each message. The first
  // unit starts at zero so title/notice always accompany the first message.
  function planWholeMessages(height, capacity, messageStarts, mode) {
    if (!Number.isFinite(height) || height <= 0 || !Number.isFinite(capacity) || capacity <= 0 || !['bubble', 'whole'].includes(mode)) throw new Error('完整气泡分页参数无效。');
    const starts = [0, ...messageStarts.filter(y => y > 0 && y < height)];
    if (starts.some((y,i) => i && y <= starts[i-1])) throw new Error('消息边界顺序无效。');
    const pages=[]; let start=0, end=starts[1] ?? height;
    for(let i=1;i<starts.length;i++) {
      const nextEnd=starts[i+1] ?? height;
      if(mode==='whole' && nextEnd-start<=capacity) end=nextEnd;
      else { pages.push({start,end}); start=starts[i]; end=nextEnd; }
    }
    pages.push({start,end});
    if(pages.length>MAX_PAGES) throw new Error('内容超过 80 张，请先缩小讨论范围再导出。');
    return pages;
  }
  function checkRasterHeight(height, whole=false) {
    const pixels=Math.round(height*SCALE);
    if(!Number.isFinite(height) || height<=0 || WIDTH*SCALE*pixels>MAX_PIXELS || pixels>16384) {
      throw new Error(whole ? '有完整消息超过浏览器单图安全尺寸，无法在不切断气泡的情况下导出。请缩短该条消息，或自行改选“智能分割多张”；不会自动截断。' : '长图超过浏览器安全尺寸，请选择智能分割多张。');
    }
  }

  if (typeof document === 'undefined') { module.exports = {planPages, planWholeMessages, checkRasterHeight, zip, pdf}; return; }
  addEventListener('pagehide', clearURLs);

  async function snapshot() {
    await document.fonts.ready;
    const stage = el('div', 'export-stage'); stage.setAttribute('aria-hidden', 'true');
    stage.append(document.querySelector('.bar').cloneNode(true), $('notice').cloneNode(true), col.cloneNode(true));
    stage.querySelector('.notice').classList.remove('folded');
    stage.querySelectorAll('[id]').forEach(n => n.removeAttribute('id'));
    stage.querySelectorAll('.barbtn,.stack,.notice button,.replybtn,.typing').forEach(n => n.remove());
    stage.querySelectorAll('.enter,.flash').forEach(n => n.classList.remove('enter', 'flash'));
    document.body.append(stage);
    try {
      await Promise.all([...stage.querySelectorAll('img')].map(img => img.decode()));
      await tick();
      const origin = stage.getBoundingClientRect().top;
      const height = Math.ceil(stage.getBoundingClientRect().height);
      const blocks = [...stage.querySelector('.col').children];
      const boundaries = blocks.slice(1).map((node, i) => (blocks[i].getBoundingClientRect().bottom + node.getBoundingClientRect().top) / 2 - origin);
      boundaries.push(height);
      const messageStarts = [];
      for(let i=0;i<blocks.length;i++) {
        if(!blocks[i].classList.contains('msg')) continue;
        let group=i;
        while(group>0 && blocks[group-1].classList.contains('day')) group--;
        messageStarts.push(group===0 ? 0 : (blocks[group-1].getBoundingClientRect().bottom + blocks[group].getBoundingClientRect().top)/2-origin);
      }
      // Header/date-only empty conversations still export one useful image.
      if(messageStarts.length) messageStarts[0]=0;
      // All line and image rectangles form a union of protected vertical bands.
      // Cutting only in the complement keeps glyphs and avatars intact.
      const bands = [];
      const walker = document.createTreeWalker(stage, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        if (!walker.currentNode.textContent.trim()) continue;
        const range = document.createRange(); range.selectNodeContents(walker.currentNode);
        for (const r of range.getClientRects()) if (r.height && r.width) bands.push([r.top - origin - 1, r.bottom - origin + 1]);
      }
      for (const img of stage.querySelectorAll('.face,.avatar,.me,.group')) { const r = img.getBoundingClientRect(); if(r.height) bands.push([r.top-origin-1,r.bottom-origin+1]); }
      bands.sort((a,b) => a[0]-b[0]);
      const merged = [];
      for (const band of bands) { const tail = merged[merged.length-1]; if(tail && band[0] <= tail[1]) tail[1] = Math.max(tail[1],band[1]); else merged.push(band.slice()); }
      const safeGaps = merged.slice(1).map((band,i) => (merged[i][1]+band[0])/2);
      // Freeze the actual browser layout/style, including color-mix and the
      // active color scheme. Rendering has no stylesheet/font/image fetches.
      const copy = stage.cloneNode(true);
      const originals = [stage, ...stage.querySelectorAll('*')], copies = [copy, ...copy.querySelectorAll('*')];
      originals.forEach((node,i) => {
        const computed = getComputedStyle(node), target = copies[i];
        target.style.cssText = '';
        for (const property of computed) target.style.setProperty(property, computed.getPropertyValue(property));
        target.style.setProperty('animation','none'); target.style.setProperty('transition','none');
      });
      copy.style.inset = 'auto'; copy.style.insetInline = 'auto'; copy.style.insetBlock = 'auto'; copy.style.position = 'relative'; copy.style.left = '0'; copy.style.top = '0'; copy.style.margin = '0';
      copy.style.height = height + 'px';
      return {height, boundaries, messageStarts, safeGaps, markup: new XMLSerializer().serializeToString(copy), background: getComputedStyle(stage).backgroundColor, ink: getComputedStyle(stage).color};
    } finally { stage.remove(); }
  }

  async function raster(snapshot, page, outputHeight, index, count, split, mime = 'image/png') {
    checkRasterHeight(outputHeight);
    const contentHeight = page.end-page.start;
    const head = split ? 22 : 0;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${outputHeight}"><foreignObject x="0" y="${head}" width="${WIDTH}" height="${contentHeight}"><div xmlns="http://www.w3.org/1999/xhtml" style="width:${WIDTH}px;height:${contentHeight}px;overflow:hidden"><div style="transform:translateY(-${page.start}px)">${snapshot.markup}</div></div></foreignObject></svg>`;
    // data: SVG (not blob: SVG) keeps foreignObject canvas origin-clean in Chromium.
    const image = new Image(); image.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
    await Promise.race([image.decode(), new Promise((_,reject) => setTimeout(() => reject(new Error('页面图像生成超时，请改用智能分割。')), 30000))]);
    const canvas = document.createElement('canvas'); canvas.width = WIDTH*SCALE; canvas.height = Math.round(outputHeight*SCALE);
    if(canvas.width*canvas.height > MAX_PIXELS || canvas.height > 16384) throw new Error('长图超过浏览器安全尺寸，请选择智能分割多张。');
    const context = canvas.getContext('2d'); if(!context) throw new Error('浏览器无法创建图像画布，请减少单张尺寸。');
    try {
      context.fillStyle = snapshot.background; context.fillRect(0,0,canvas.width,canvas.height);
      context.scale(SCALE,SCALE); context.drawImage(image,0,0);
      if(split) { context.fillStyle = snapshot.ink; context.globalAlpha = .65; context.font = '11px -apple-system, "PingFang SC", sans-serif'; context.fillText(`产品顾问团 · ${index+1} / ${count}${page.start ? ' · 接上页' : ''}`,20,15); context.fillText(index+1<count ? '下页继续 →' : '讨论记录 · AI 视角，非本人发言',20,outputHeight-12); }
      return await new Promise((resolve,reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('图像编码失败，请选择智能分割。')), mime, .95));
    } finally { canvas.width=1; canvas.height=1; }
  }

  // Minimal writer for PDF version 1.4: each page embeds an opaque JPEG of the browser
  // layout. Byte offsets include binary streams; no fonts or remote libraries.
  async function pdf(files) {
    if (!files.length || files.length > MAX_PAGES) throw new Error('PDF 页数须为 1–80 页。');
    const encoder = new TextEncoder(), parts = [], offsets = [0]; let size = 0;
    const append = value => { const bytes = typeof value === 'string' ? encoder.encode(value) : value; parts.push(bytes); size += bytes.length; };
    const object = (id, content) => { offsets[id] = size; append(`${id} 0 obj\n${content}\nendobj\n`); };
    append('%PDF-1.4\n%'); append(new Uint8Array([226,227,207,211])); append('\n');
    object(1, '<< /Type /Catalog /Pages 2 0 R >>');
    object(2, `<< /Type /Pages /Count ${files.length} /Kids [${files.map((_,i) => `${3+i*3} 0 R`).join(' ')}] >>`);
    for (let i=0; i<files.length; i++) {
      const file = files[i], id = 3+i*3, bytes = new Uint8Array(await file.blob.arrayBuffer());
      if (file.blob.type !== 'image/jpeg' || bytes[0] !== 255 || bytes[1] !== 216) throw new Error('PDF 页面必须为有效 JPEG 图像。');
      if (!Number.isInteger(file.width) || !Number.isInteger(file.height) || file.width < 1 || file.height < 1) throw new Error('PDF 页面尺寸无效。');
      const w = 595.28, h = +(w*file.height/file.width).toFixed(2);
      object(id, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}] /Resources << /XObject << /Im0 ${id+1} 0 R >> >> /Contents ${id+2} 0 R >>`);
      offsets[id+1] = size;
      append(`${id+1} 0 obj\n<< /Type /XObject /Subtype /Image /Width ${file.width} /Height ${file.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${bytes.length} >>\nstream\n`);
      append(bytes); append('\nendstream\nendobj\n');
      const commands = `q\n${w} 0 0 ${h} 0 0 cm\n/Im0 Do\nQ\n`;
      object(id+2, `<< /Length ${encoder.encode(commands).length} >>\nstream\n${commands}endstream`);
    }
    const start = size;
    append(`xref\n0 ${offsets.length}\n0000000000 65535 f \n`);
    for (let i=1; i<offsets.length; i++) append(`${String(offsets[i]).padStart(10,'0')} 00000 n \n`);
    append(`trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`);
    return new Blob(parts,{type:'application/pdf'});
  }

  // Small store-only ZIP writer. PNG is already compressed; UTF-8 filenames.
  async function zip(files) {
    const table = new Uint32Array(256);
    for(let n=0;n<256;n++){let c=n;for(let j=0;j<8;j++)c=c&1?0xedb88320^(c>>>1):c>>>1;table[n]=c>>>0;}
    const parts=[], central=[]; let offset=0, centralSize=0;
    for(const file of files){
      const bytes=new Uint8Array(await file.blob.arrayBuffer()), name=new TextEncoder().encode(file.name);
      let crc=0xffffffff;for(const byte of bytes)crc=table[(crc^byte)&255]^(crc>>>8);crc=(crc^0xffffffff)>>>0;
      const local=new Uint8Array(30+name.length), l=new DataView(local.buffer);
      l.setUint32(0,0x04034b50,true);l.setUint16(4,20,true);l.setUint16(6,0x800,true);l.setUint16(12,33,true);l.setUint32(14,crc,true);l.setUint32(18,bytes.length,true);l.setUint32(22,bytes.length,true);l.setUint16(26,name.length,true);local.set(name,30);
      const entry=new Uint8Array(46+name.length), c=new DataView(entry.buffer);
      c.setUint32(0,0x02014b50,true);c.setUint16(4,20,true);c.setUint16(6,20,true);c.setUint16(8,0x800,true);c.setUint16(14,33,true);c.setUint32(16,crc,true);c.setUint32(20,bytes.length,true);c.setUint32(24,bytes.length,true);c.setUint16(28,name.length,true);c.setUint32(42,offset,true);entry.set(name,46);
      parts.push(local,bytes);central.push(entry);offset+=local.length+bytes.length;centralSize+=entry.length;
    }
    const end=new Uint8Array(22), d=new DataView(end.buffer);d.setUint32(0,0x06054b50,true);d.setUint16(8,files.length,true);d.setUint16(10,files.length,true);d.setUint32(12,centralSize,true);d.setUint32(16,offset,true);
    return new Blob([...parts,...central,end],{type:'application/zip'});
  }

  $('exportBtn').addEventListener('click', () => {
    if(busy) return;
    clearURLs();
    openSheet(sheet => {
      sheet.style.removeProperty('--hue');
      sheet.setAttribute('aria-label','导出聊天记录');
      sheet.append(el('h3','','导出聊天记录'),el('p','foot','保留头像、对话气泡、引用与决议卡。1080 像素高清图片或多页 PDF，全部在本机生成。PDF 保留聊天视觉样式，文字不可选中复制。'));
      const options=el('div','export-options');
      const modeLabel=el('label','','导出方式'), mode=el('select');mode.id='exportMode';
      for(const [value,text] of [['long','单张长图'],['split','智能分割多张'],['bubble','单个气泡一张（不切断）'],['whole','完整气泡拼图（不切断）'],['pdf','PDF 文档（智能分页）']]){const o=el('option','',text);o.value=value;mode.append(o);}modeLabel.append(mode);
      const ratioLabel=el('label','','页面比例'), ratio=el('select');ratio.id='exportRatio';
      for(const [value,text] of [['16/9','9:16 · 常规手机'],['19.5/9','9:19.5 · 手机长屏'],['4/3','3:4 · 图文分享'],['5/4','4:5 · 信息流'],['1/1','1:1 · 正方形']]){const o=el('option','',text);o.value=value;ratio.append(o);}ratioLabel.append(ratio);ratioLabel.hidden=true;
      const a4=el('option','','A4 · 文档');a4.value='297/210';a4.hidden=true;ratio.prepend(a4);
      const hint=el('p','foot');hint.id='exportHint';
      function updateMode(){
        ratioLabel.hidden=['long','bubble'].includes(mode.value);a4.hidden=mode.value!=='pdf';
        if(mode.value==='pdf')ratio.value=a4.value;else if(ratio.value===a4.value)ratio.value='16/9';
        const hints={long:'单张长图保持全部聊天内容，不受页面比例限制。',split:'每张保持所选比例。优先整条消息分页；超长内容在文字行间续接。',pdf:'按所选页面比例智能分页；超长消息在文字行间续接。',bubble:'每条完整消息一张，按内容自然高度导出，不固定比例。头像、姓名、时间、引用及卡片一起保留；标题公告并入首张，日期跟随对应消息。',whole:'按所选比例尽量放入多个完整消息，放不下就换下一张。超出一页的消息独占一张更高图片，不截断；标题公告并入首张。'};
        hint.textContent=hints[mode.value]+(['bubble','whole'].includes(mode.value)?' 单条超出浏览器安全尺寸会报错，不会自动切开。':'')+' 导出当前已显示的消息。';
      }
      mode.addEventListener('change',updateMode);updateMode();options.append(modeLabel,ratioLabel);sheet.append(options,hint);
      const action=el('button','send','生成预览');action.id='exportGenerate';action.type='button';
      const status=el('p','export-status');status.id='exportStatus';status.setAttribute('role','status');
      const downloads=el('div','export-actions'), results=el('div','export-results');results.id='exportResults';
      sheet.append(action,status,downloads,results);
      action.addEventListener('click',async()=>{
        if(busy)return;
        if(draining || queue.length) { status.textContent='正在回放或接收消息，请等待对话显示完整后再导出。'; return; }
        busy=true;action.disabled=true;mode.disabled=true;ratio.disabled=true;clearURLs();results.textContent='';downloads.textContent='';status.textContent='正在准备聊天内容…';
        try{
          const snap=await snapshot(), isPDF=mode.value==='pdf', split=mode.value!=='long', whole=['bubble','whole'].includes(mode.value);
          const [h,w]=ratio.value.split('/').map(Number), target=Math.round(WIDTH*h/w);
          if(!split && (WIDTH*SCALE*Math.ceil(snap.height*SCALE)>MAX_PIXELS || snap.height*SCALE>16384))throw new Error('内容过长，单张会超过浏览器安全尺寸。请选择“智能分割多张”。');
          const pages=whole?planWholeMessages(snap.height,target-52,snap.messageStarts,mode.value):split?planPages(snap.height,target-52,snap.boundaries,snap.safeGaps):[{start:0,end:snap.height}];
          const outputHeights=pages.map(page=>whole?(mode.value==='bubble'?Math.ceil(page.end-page.start)+52:Math.max(target,Math.ceil(page.end-page.start)+52)):split?target:snap.height);
          // Preflight every page before image decoding/allocation or partial downloads.
          outputHeights.forEach(height=>checkRasterHeight(height,whole));
          const files=[];let totalBytes=0;
          for(let i=0;i<pages.length;i++){
            status.textContent=`正在生成 ${i+1} / ${pages.length} 张…`;await tick();
            const outputHeight=outputHeights[i], blob=await raster(snap,pages[i],outputHeight,i,pages.length,split,isPDF?'image/jpeg':'image/png');
            totalBytes+=blob.size;if(totalBytes>150*1024*1024)throw new Error('图片总量超过 150 MB，请缩小讨论范围后重试。');
            const name=`${filename()}-${String(i+1).padStart(2,'0')}.${isPDF?'jpg':'png'}`, url=objectURL(blob);files.push({name,blob,width:WIDTH*SCALE,height:Math.round(outputHeight*SCALE)});
            const figure=el('figure','export-preview'), img=el('img');img.src=url;img.alt=`聊天图片 ${i+1}，共 ${pages.length} 张`;img.loading='lazy';
            const caption=el('figcaption'), download=el('button','barbtn',isPDF?'下载此页 JPG':'下载 PNG');download.type='button';download.addEventListener('click',()=>save(url,name));
            caption.append(el('span','',`${i+1} / ${pages.length} · 1080 × ${Math.round(outputHeight*SCALE)}`),download);figure.append(img,caption);results.append(figure);
          }
          if(isPDF){status.textContent='正在封装 PDF…';await tick();const documentURL=objectURL(await pdf(files)), download=el('button','barbtn','下载 PDF');download.id='exportPdf';download.addEventListener('click',()=>save(documentURL,filename()+'-聊天记录.pdf'));downloads.append(download);}
          else if(files.length>1){const archive=objectURL(await zip(files)), download=el('button','barbtn','整包下载 ZIP');download.id='exportZip';download.addEventListener('click',()=>save(archive,filename()+'-聊天图片.zip'));downloads.append(download);}
          status.textContent=isPDF?`已生成 ${files.length} 页 PDF。点击“下载 PDF”保存完整文档；以下为逐页预览。`:`已生成 ${files.length} 张。可分别下载${files.length>1?'，也可整包下载后解压':''}；手机也可长按预览保存。`;
        }catch(error){clearURLs();results.textContent='';downloads.textContent='';status.textContent='导出未完成：'+error.message;}finally{busy=false;action.disabled=false;mode.disabled=false;ratio.disabled=false;}
      });
    });
  });

})();
