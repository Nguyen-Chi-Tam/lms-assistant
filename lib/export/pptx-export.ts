import JSZip from 'jszip';
import PptxGenJS from 'pptxgenjs';

export type SlideLayoutKind =
  | 'bullets'
  | 'comparison'
  | 'timeline'
  | 'process'
  | 'stat'
  | 'quote'
  | 'cards'
  | 'quadrant';

export interface SlideVisualData {
  leftLabel?: string;
  leftPoints?: string[];
  rightLabel?: string;
  rightPoints?: string[];
  steps?: Array<{ label: string; description?: string }>;
  value?: string;
  context?: string;
  quote?: string;
  author?: string;
  cards?: Array<{ title: string; description?: string }>;
  quadrants?: Array<{ title: string; description?: string }>;
}

export interface SlideItem {
  slideNumber?: number;
  title: string;
  subtitle?: string;
  bullets: string[];
  keyTakeaway?: string;
  notes?: string;
  layout?: SlideLayoutKind;
  visual?: SlideVisualData;
}

export interface SlideDeckData {
  title: string;
  topic?: string;
  slides: SlideItem[];
}

/**
 * Exports a slide deck as a real PowerPoint file using PptxGenJS.
 */
export async function exportSlidesToPptx(
  deck: SlideDeckData,
  courseTitle: string
): Promise<void> {
  const pptx = new PptxGenJS();
  pptx.layout = 'LAYOUT_WIDE';
  pptx.author = 'LMS Assistant';
  pptx.company = 'LMS Assistant';
  pptx.subject = deck.topic || courseTitle;
  pptx.title = deck.title || courseTitle;

  const slides = deck.slides && deck.slides.length > 0 ? deck.slides : [
    {
      title: deck.title || courseTitle,
      subtitle: `Môn học: ${courseTitle}`,
      bullets: ['Nội dung bài giảng đang được cập nhật.'],
      notes: 'Slide tổng quan mở đầu bài giảng.',
    },
  ];

  slides.forEach((slideData, index) => {
    const slide = pptx.addSlide();
    const isTitleSlide = index === 0;
    const title = slideData.title || `Trang ${index + 1}`;
    const subtitle = slideData.subtitle || (isTitleSlide ? courseTitle : '');
    const layout = slideData.layout || (isTitleSlide ? 'quote' : 'bullets');
    const visual = slideData.visual || {};

    slide.background = { color: isTitleSlide ? '0B0F19' : '0F172A' };
    slide.addShape(pptx.ShapeType.rect, {
      x: 0,
      y: 0,
      w: 13.333,
      h: 0.1,
      line: { color: '7C6DF2', transparency: 100 },
      fill: { color: '7C6DF2' },
    });

    slide.addText(title, {
      x: 0.8,
      y: isTitleSlide ? 2 : 0.7,
      w: 11.7,
      h: isTitleSlide ? 0.8 : 0.5,
      align: isTitleSlide ? 'center' : 'left',
      fontFace: 'Aptos Display',
      fontSize: isTitleSlide ? 28 : 22,
      bold: true,
      color: 'FFFFFF',
      margin: 0,
      breakLine: false,
      fit: 'shrink',
    });

    if (subtitle) {
      slide.addText(subtitle, {
        x: 0.8,
        y: isTitleSlide ? 3 : 1.35,
        w: 11.7,
        h: 0.35,
        align: isTitleSlide ? 'center' : 'left',
        fontFace: 'Aptos',
        fontSize: 12,
        italic: true,
        color: '94A3B8',
        margin: 0,
        fit: 'shrink',
      });
    }

    if (!isTitleSlide) {
      if (layout === 'comparison' && (visual.leftLabel || visual.rightLabel)) {
        addComparisonPptx(slide, visual);
      } else if ((layout === 'timeline' || layout === 'process') && visual.steps?.length) {
        addStepsPptx(slide, visual.steps);
      } else if (layout === 'stat' && visual.value) {
        slide.addText(visual.value, {
          x: 0.8, y: 2.0, w: 4.2, h: 1.4, fontFace: 'Aptos Display',
          fontSize: 42, bold: true, color: 'A594FD', margin: 0, fit: 'shrink',
        });
        slide.addText(visual.context || slideData.keyTakeaway || '', {
          x: 5.2, y: 2.25, w: 7.2, h: 1.1, fontFace: 'Aptos',
          fontSize: 20, color: 'F1F5F9', margin: 0, valign: 'middle', fit: 'shrink',
        });
      } else if (layout === 'quote' && visual.quote) {
        slide.addText(`“${visual.quote}”`, {
          x: 1.1, y: 2.0, w: 11.1, h: 1.5, fontFace: 'Aptos Display',
          fontSize: 28, italic: true, color: 'F1F5F9', align: 'center',
          valign: 'middle', margin: 0, fit: 'shrink',
        });
        if (visual.author) {
          slide.addText(`— ${visual.author}`, {
            x: 1.1, y: 3.75, w: 11.1, h: 0.3, fontFace: 'Aptos',
            fontSize: 13, color: 'A594FD', align: 'center', margin: 0,
          });
        }
      } else if (layout === 'cards' && visual.cards?.length) {
        addCardsPptx(slide, visual.cards);
      } else if (layout === 'quadrant' && visual.quadrants?.length) {
        addCardsPptx(slide, visual.quadrants);
      } else {
      const bulletText = (slideData.bullets || []).map(text => ({
        text: text.replace(/\*\*/g, ''),
        options: { bullet: { indent: 18 }, hanging: 4 },
      }));

      if (bulletText.length > 0) {
        slide.addText(bulletText, {
          x: 0.8,
          y: 2.05,
          w: 11.7,
          h: 3.9,
          fontFace: 'Aptos',
          fontSize: 18,
          color: 'F1F5F9',
          breakLine: true,
          paraSpaceAfter: 12,
          margin: 0,
          valign: 'top',
          fit: 'shrink',
        });
      }
      }

      if (slideData.keyTakeaway) {
        slide.addText([
          { text: 'Điểm cốt lõi: ', options: { bold: true, color: 'A594FD' } },
          { text: slideData.keyTakeaway.replace(/\*\*/g, ''), options: { italic: true, color: 'CBD5E1' } },
        ], {
          x: 0.8,
          y: 5.75,
          w: 11.7,
          h: 0.4,
          fontFace: 'Aptos',
          fontSize: 13,
          margin: 0,
          fit: 'shrink',
        });
      }
    }

    function addComparisonPptx(slide: PptxGenJS.Slide, visual: SlideVisualData): void {
      const columns = [
        { label: visual.leftLabel || 'A', points: visual.leftPoints || [] },
        { label: visual.rightLabel || 'B', points: visual.rightPoints || [] },
      ];
      columns.forEach((column, index) => {
        const x = index === 0 ? 0.8 : 6.85;
        slide.addShape(PptxGenJS.ShapeType.roundRect, {
          x, y: 2.0, w: 5.65, h: 3.45,
          rectRadius: 0.08,
          line: { color: index === 0 ? '7C6DF2' : '38BDF8', transparency: 35 },
          fill: { color: index === 0 ? '241B43' : '102B3D', transparency: 8 },
        });
        slide.addText(column.label, {
          x: x + 0.3, y: 2.3, w: 5.05, h: 0.35,
          fontFace: 'Aptos Display', fontSize: 20, bold: true,
          color: index === 0 ? 'A594FD' : '7DD3FC', margin: 0,
        });
        slide.addText(column.points.map(text => ({
          text: text.replace(/\*\*/g, ''),
          options: { bullet: { indent: 16 }, hanging: 4 },
        })), {
          x: x + 0.3, y: 2.85, w: 5.0, h: 2.2, fontFace: 'Aptos',
          fontSize: 15, color: 'F1F5F9', breakLine: true, paraSpaceAfter: 10,
          margin: 0, fit: 'shrink',
        });
      });
    }

    function addStepsPptx(
      slide: PptxGenJS.Slide,
      steps: Array<{ label: string; description?: string }>
    ): void {
      const width = Math.min(3.55, 11.8 / Math.max(steps.length, 1));
      steps.slice(0, 4).forEach((step, index) => {
        const x = 0.7 + index * (width + 0.18);
        slide.addShape(PptxGenJS.ShapeType.ellipse, {
          x: x + width / 2 - 0.22, y: 2.0, w: 0.44, h: 0.44,
          line: { color: 'A594FD', transparency: 100 }, fill: { color: '7C6DF2' },
        });
        slide.addText(`${index + 1}`, {
          x: x + width / 2 - 0.22, y: 2.08, w: 0.44, h: 0.15,
          fontFace: 'Aptos', fontSize: 10, bold: true, color: 'FFFFFF',
          align: 'center', margin: 0,
        });
        slide.addText(step.label, {
          x, y: 2.65, w: width, h: 0.45, fontFace: 'Aptos Display',
          fontSize: 16, bold: true, color: 'FFFFFF', align: 'center', margin: 0,
          fit: 'shrink',
        });
        slide.addText(step.description || '', {
          x, y: 3.2, w: width, h: 1.1, fontFace: 'Aptos', fontSize: 12,
          color: 'CBD5E1', align: 'center', valign: 'top', margin: 0, fit: 'shrink',
        });
      });
    }

    function addCardsPptx(
      slide: PptxGenJS.Slide,
      cards: Array<{ title: string; description?: string }>
    ): void {
      const visibleCards = cards.slice(0, 4);
      const columns = visibleCards.length <= 2 ? visibleCards.length : 2;
      const cardWidth = columns === 1 ? 7.5 : 5.65;
      visibleCards.forEach((card, index) => {
        const row = Math.floor(index / columns);
        const column = index % columns;
        const x = columns === 1 ? 2.9 : 0.8 + column * 6.05;
        const y = 1.9 + row * 2.15;
        slide.addShape(PptxGenJS.ShapeType.roundRect, {
          x, y, w: cardWidth, h: 1.7,
          line: { color: 'A594FD', transparency: 45 },
          fill: { color: '241B43', transparency: 5 },
        });
        slide.addText(card.title, {
          x: x + 0.25, y: y + 0.25, w: cardWidth - 0.5, h: 0.3,
          fontFace: 'Aptos Display', fontSize: 16, bold: true, color: 'A594FD',
          margin: 0, fit: 'shrink',
        });
        slide.addText(card.description || '', {
          x: x + 0.25, y: y + 0.7, w: cardWidth - 0.5, h: 0.7,
          fontFace: 'Aptos', fontSize: 12, color: 'E2E8F0', margin: 0, fit: 'shrink',
        });
      });
    }

    slide.addText(`${courseTitle} · Trang ${index + 1} / ${slides.length}`, {
      x: 0.8,
      y: 6.55,
      w: 11.7,
      h: 0.2,
      align: 'right',
      fontFace: 'Aptos',
      fontSize: 9,
      color: '64748B',
      margin: 0,
    });

    if (slideData.notes) {
      slide.addNotes(slideData.notes);
    }
  });

  const sanitizedName = (deck.title || courseTitle || 'Slide_Bai_Giang')
    .replace(/[^a-zA-Z0-9_\u00C0-\u024F\u1E00-\u1EFF]/g, '_')
    .slice(0, 40);
  try {
    await pptx.writeFile({ fileName: `${sanitizedName}_Slide.pptx` });
  } catch (error) {
    console.warn('PptxGenJS export failed, using the legacy browser fallback:', error);
    await exportSlidesToPptxLegacy(deck, courseTitle);
  }
}

function escapeXml(unsafe: string): string {
  if (!unsafe) return '';
  return unsafe
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Builds a genuine, valid OpenXML PowerPoint (.pptx) file using JSZip.
 * Supported across Microsoft PowerPoint, Google Slides, LibreOffice, and Apple Keynote.
 */
async function exportSlidesToPptxLegacy(
  deck: SlideDeckData,
  courseTitle: string
): Promise<void> {
  const zip = new JSZip();

  const slides = deck.slides && deck.slides.length > 0 ? deck.slides : [
    {
      title: deck.title || courseTitle,
      subtitle: `Môn học: ${courseTitle}`,
      bullets: ['Nội dung bài giảng đang được cập nhật.'],
      notes: 'Slide tổng quan mở đầu bài giảng.'
    }
  ];

  // 1. [Content_Types].xml
  let contentTypesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>
  <Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>
  <Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>
`;

  slides.forEach((_, idx) => {
    contentTypesXml += `  <Override PartName="/ppt/slides/slide${idx + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>\n`;
  });

  contentTypesXml += `</Types>`;
  zip.file('[Content_Types].xml', contentTypesXml);

  // 2. _rels/.rels
  const rootRelsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>
</Relationships>`;
  zip.file('_rels/.rels', rootRelsXml);

  // 3. ppt/presentation.xml
  let sldIdLstXml = '';
  slides.forEach((_, idx) => {
    sldIdLstXml += `    <p:sldId id="${256 + idx}" r:id="rId${idx + 2}"/>\n`;
  });

  const presentationXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:sldMasterIdLst>
    <p:sldMasterId id="2147483648" r:id="rId1"/>
  </p:sldMasterIdLst>
  <p:sldIdLst>
${sldIdLstXml}  </p:sldIdLst>
  <p:sldSz cx="12192000" cy="6858000" type="screen16x9"/>
  <p:notesSz cx="6858000" cy="9144000"/>
</p:presentation>`;
  zip.file('ppt/presentation.xml', presentationXml);

  // 4. ppt/_rels/presentation.xml.rels
  let presRelsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="slideMasters/slideMaster1.xml"/>
`;

  slides.forEach((_, idx) => {
    presRelsXml += `  <Relationship Id="rId${idx + 2}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${idx + 1}.xml"/>\n`;
  });

  presRelsXml += `</Relationships>`;
  zip.file('ppt/_rels/presentation.xml.rels', presRelsXml);

  // 5. ppt/slideMasters/slideMaster1.xml & rels
  const slideMasterXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldMaster xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld>
    <p:bg>
      <p:bgPr>
        <a:solidFill>
          <a:srgbClr val="0F172A"/>
        </a:solidFill>
      </p:bgPr>
    </p:bg>
    <p:spTree>
      <p:nvGrpSpPr>
        <p:cNvPr id="1" name=""/>
        <p:cNvGrpSpPr/>
        <p:nvPr/>
      </p:nvGrpSpPr>
      <p:grpSpPr/>
    </p:spTree>
  </p:cSld>
  <p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>
  <p:sldLayoutIdLst>
    <p:sldLayoutId id="2147483649" r:id="rId1"/>
  </p:sldLayoutIdLst>
  <p:txStyles>
    <p:titleStyle>
      <a:lvl1pPr algn="l">
        <a:defRPr sz="4000" b="1">
          <a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill>
          <a:latin typeface="Segoe UI"/>
        </a:defRPr>
      </a:lvl1pPr>
    </p:titleStyle>
    <p:bodyStyle>
      <a:lvl1pPr algn="l">
        <a:defRPr sz="2000">
          <a:solidFill><a:srgbClr val="E2E8F0"/></a:solidFill>
          <a:latin typeface="Segoe UI"/>
        </a:defRPr>
      </a:lvl1pPr>
    </p:bodyStyle>
    <p:otherStyle/>
  </p:txStyles>
</p:sldMaster>`;
  zip.file('ppt/slideMasters/slideMaster1.xml', slideMasterXml);

  const slideMasterRelsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>
</Relationships>`;
  zip.file('ppt/slideMasters/_rels/slideMaster1.xml.rels', slideMasterRelsXml);

  // 6. ppt/slideLayouts/slideLayout1.xml & rels
  const slideLayoutXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldLayout xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" type="cust">
  <p:cSld name="Custom Layout">
    <p:spTree>
      <p:nvGrpSpPr>
        <p:cNvPr id="1" name=""/>
        <p:cNvGrpSpPr/>
        <p:nvPr/>
      </p:nvGrpSpPr>
      <p:grpSpPr/>
    </p:spTree>
  </p:cSld>
</p:sldLayout>`;
  zip.file('ppt/slideLayouts/slideLayout1.xml', slideLayoutXml);

  const slideLayoutRelsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="../slideMasters/slideMaster1.xml"/>
</Relationships>`;
  zip.file('ppt/slideLayouts/_rels/slideLayout1.xml.rels', slideLayoutRelsXml);

  // 7. Generate individual slides
  slides.forEach((slide, idx) => {
    const isTitleSlide = idx === 0;
    const titleText = escapeXml(slide.title || `Trang ${idx + 1}`);
    const subtitleText = escapeXml(slide.subtitle || (isTitleSlide ? courseTitle : ''));
    const keyTakeawayText = slide.keyTakeaway ? escapeXml(slide.keyTakeaway) : '';

    let bulletParagraphsXml = '';
    (slide.bullets || []).forEach(bullet => {
      bulletParagraphsXml += `
        <a:p>
          <a:pPr lvl="0" marL="288000" indent="-288000">
            <a:buChar char="•"/>
          </a:pPr>
          <a:r>
            <a:rPr lang="vi-VN" sz="1800">
              <a:solidFill><a:srgbClr val="F1F5F9"/></a:solidFill>
              <a:latin typeface="Segoe UI"/>
            </a:rPr>
            <a:t>${escapeXml(bullet)}</a:t>
          </a:r>
        </a:p>`;
    });

    const slideXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld>
    <p:bg>
      <p:bgPr>
        <a:solidFill>
          <a:srgbClr val="${isTitleSlide ? '0B0F19' : '0F172A'}"/>
        </a:solidFill>
      </p:bgPr>
    </p:bg>
    <p:spTree>
      <p:nvGrpSpPr>
        <p:cNvPr id="1" name=""/>
        <p:cNvGrpSpPr/>
        <p:nvPr/>
      </p:nvGrpSpPr>
      <p:grpSpPr/>

      <!-- Decorative top accent bar -->
      <p:sp>
        <p:nvSpPr>
          <p:cNvPr id="2" name="Accent Line"/>
          <p:cNvSpPr/>
          <p:nvPr/>
        </p:nvSpPr>
        <p:spPr>
          <a:xfrm>
            <a:off x="0" y="0"/>
            <a:ext cx="12192000" cy="91440"/>
          </a:xfrm>
          <a:prstGeom prst="rect"><a:avLst/></a:prstGeom>
          <a:solidFill><a:srgbClr val="7C6DF2"/></a:solidFill>
        </p:spPr>
      </p:sp>

      <!-- Slide Title & Subtitle Container -->
      <p:sp>
        <p:nvSpPr>
          <p:cNvPr id="3" name="Title Box"/>
          <p:cNvSpPr/>
          <p:nvPr/>
        </p:nvSpPr>
        <p:spPr>
          <a:xfrm>
            <a:off x="731520" y="${isTitleSlide ? '1828800' : '640080'}"/>
            <a:ext cx="10728960" cy="${isTitleSlide ? '1828800' : '1097280'}"/>
          </a:xfrm>
          <a:prstGeom prst="rect"><a:avLst/></a:prstGeom>
          <a:noFill/>
        </p:spPr>
        <p:txBody>
          <a:bodyPr vert="horz" lIns="0" tIns="0" rIns="0" bIns="0" rtlCol="0" anchor="${isTitleSlide ? 'ctr' : 't'}"/>
          <a:lstStyle/>
          <a:p>
            <a:pPr algn="${isTitleSlide ? 'ctr' : 'l'}"/>
            <a:r>
              <a:rPr lang="vi-VN" sz="${isTitleSlide ? '3600' : '2600'}" b="1">
                <a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill>
                <a:latin typeface="Segoe UI"/>
              </a:rPr>
              <a:t>${titleText}</a:t>
            </a:r>
          </a:p>
          ${subtitleText ? `
          <a:p>
            <a:pPr algn="${isTitleSlide ? 'ctr' : 'l'}">
              <a:spcBfr><a:spcPts val="1200"/></a:spcBfr>
            </a:pPr>
            <a:r>
              <a:rPr lang="vi-VN" sz="1600" i="1">
                <a:solidFill><a:srgbClr val="94A3B8"/></a:solidFill>
                <a:latin typeface="Segoe UI"/>
              </a:rPr>
              <a:t>${subtitleText}</a:t>
            </a:r>
          </a:p>` : ''}
        </p:txBody>
      </p:sp>

      <!-- Slide Body Content -->
      ${!isTitleSlide ? `
      <p:sp>
        <p:nvSpPr>
          <p:cNvPr id="4" name="Content Box"/>
          <p:cNvSpPr/>
          <p:nvPr/>
        </p:nvSpPr>
        <p:spPr>
          <a:xfrm>
            <a:off x="731520" y="1920240"/>
            <a:ext cx="10728960" cy="3840480"/>
          </a:xfrm>
          <a:prstGeom prst="rect"><a:avLst/></a:prstGeom>
          <a:noFill/>
        </p:spPr>
        <p:txBody>
          <a:bodyPr vert="horz" lIns="0" tIns="0" rIns="0" bIns="0" rtlCol="0"/>
          <a:lstStyle/>
          ${bulletParagraphsXml}
          ${keyTakeawayText ? `
          <a:p>
            <a:pPr>
              <a:spcBfr><a:spcPts val="1800"/></a:spcBfr>
            </a:pPr>
            <a:r>
              <a:rPr lang="vi-VN" sz="1500" b="1">
                <a:solidFill><a:srgbClr val="A594FD"/></a:solidFill>
                <a:latin typeface="Segoe UI"/>
              </a:rPr>
              <a:t>💡 Điểm cốt lõi: </a:t>
            </a:r>
            <a:r>
              <a:rPr lang="vi-VN" sz="1500" i="1">
                <a:solidFill><a:srgbClr val="CBD5E1"/></a:solidFill>
                <a:latin typeface="Segoe UI"/>
              </a:rPr>
              <a:t>${keyTakeawayText}</a:t>
            </a:r>
          </a:p>` : ''}
        </p:txBody>
      </p:sp>` : ''}

      <!-- Footer / Slide Number & Course Info -->
      <p:sp>
        <p:nvSpPr>
          <p:cNvPr id="5" name="Footer"/>
          <p:cNvSpPr/>
          <p:nvPr/>
        </p:nvSpPr>
        <p:spPr>
          <a:xfrm>
            <a:off x="731520" y="6126480"/>
            <a:ext cx="10728960" cy="457200"/>
          </a:xfrm>
          <a:prstGeom prst="rect"><a:avLst/></a:prstGeom>
          <a:noFill/>
        </p:spPr>
        <p:txBody>
          <a:bodyPr vert="horz" lIns="0" tIns="0" rIns="0" bIns="0" rtlCol="0"/>
          <a:lstStyle/>
          <a:p>
            <a:pPr algn="r"/>
            <a:r>
              <a:rPr lang="vi-VN" sz="1100">
                <a:solidFill><a:srgbClr val="64748B"/></a:solidFill>
                <a:latin typeface="Segoe UI"/>
              </a:rPr>
              <a:t>${courseTitle} · Trang ${idx + 1} / ${slides.length}</a:t>
            </a:r>
          </a:p>
        </p:txBody>
      </p:sp>

    </p:spTree>
  </p:cSld>
</p:sld>`;

    zip.file(`ppt/slides/slide${idx + 1}.xml`, slideXml);

    const slideRelsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>
</Relationships>`;
    zip.file(`ppt/slides/_rels/slide${idx + 1}.xml.rels`, slideRelsXml);
  });

  const blob = await zip.generateAsync({
    type: 'blob',
    mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  });

  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  const sanitizedName = (deck.title || courseTitle || 'Slide_Bai_Giang')
    .replace(/[^a-zA-Z0-9_\u00C0-\u024F\u1E00-\u1EFF]/g, '_')
    .slice(0, 40);
  a.download = `${sanitizedName}_Slide.pptx`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/**
 * Exports the slide deck as a standalone interactive HTML presentation.
 * Features full keyboard navigation, fullscreen mode, dark theme, speaker notes, and print styling.
 */
export function exportSlidesToHtml(deck: SlideDeckData, courseTitle: string): void {
  const slides = deck.slides && deck.slides.length > 0 ? deck.slides : [];
  const deckTitle = deck.title || `Bài giảng: ${courseTitle}`;

  const htmlContent = `<!DOCTYPE html>
<html lang="vi">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeXml(deckTitle)}</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: 'Segoe UI', system-ui, -apple-system, sans-serif;
    background: #0b0f19;
    color: #f8fafc;
    min-height: 100vh;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }
  header {
    background: rgba(15, 23, 42, 0.95);
    backdrop-filter: blur(12px);
    border-bottom: 1px solid rgba(124, 109, 242, 0.2);
    padding: 12px 24px;
    display: flex;
    justify-content: space-between;
    align-items: center;
    z-index: 10;
  }
  .brand {
    display: flex;
    align-items: center;
    gap: 10px;
    font-size: 15px;
    font-weight: 700;
    color: #a594fd;
  }
  .controls {
    display: flex;
    align-items: center;
    gap: 12px;
  }
  button {
    background: rgba(124, 109, 242, 0.2);
    color: #f1f5f9;
    border: 1px solid rgba(124, 109, 242, 0.4);
    padding: 6px 14px;
    border-radius: 8px;
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    transition: all 0.2s;
  }
  button:hover {
    background: rgba(124, 109, 242, 0.4);
    border-color: #7c6df2;
  }
  main {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 30px;
    position: relative;
  }
  .slide-container {
    width: 100%;
    max-width: 1100px;
    aspect-ratio: 16 / 9;
    background: linear-gradient(145deg, #0f172a 0%, #1e1b4b 100%);
    border: 1px solid rgba(124, 109, 242, 0.35);
    border-radius: 18px;
    box-shadow: 0 20px 50px rgba(0, 0, 0, 0.6);
    padding: 48px 56px;
    display: flex;
    flex-direction: column;
    justify-content: space-between;
    position: relative;
    overflow: hidden;
  }
  .slide-badge {
    position: absolute;
    top: 20px;
    right: 28px;
    font-size: 12px;
    font-weight: 700;
    color: #a594fd;
    background: rgba(124, 109, 242, 0.15);
    border: 1px solid rgba(124, 109, 242, 0.3);
    padding: 3px 10px;
    border-radius: 20px;
  }
  .slide-title {
    font-size: 32px;
    font-weight: 800;
    color: #ffffff;
    line-height: 1.25;
    margin-bottom: 8px;
  }
  .slide-subtitle {
    font-size: 16px;
    color: #94a3b8;
    margin-bottom: 24px;
    font-weight: 500;
  }
  .slide-bullets {
    flex: 1;
    list-style: none;
    display: flex;
    flex-direction: column;
    gap: 14px;
    margin-top: 10px;
  }
  .slide-bullets li {
    font-size: 18px;
    line-height: 1.5;
    color: #e2e8f0;
    display: flex;
    align-items: flex-start;
    gap: 12px;
  }
  .slide-bullets li::before {
    content: "•";
    color: #7c6df2;
    font-size: 26px;
    line-height: 1;
  }
  .slide-takeaway {
    margin-top: 20px;
    background: rgba(124, 109, 242, 0.15);
    border-left: 4px solid #7c6df2;
    padding: 12px 18px;
    border-radius: 8px;
    font-size: 15px;
    color: #cbd5e1;
    font-style: italic;
  }
  .slide-visual { flex: 1; display: flex; align-items: center; }
  .visual-grid { width: 100%; display: grid; grid-template-columns: repeat(2, 1fr); gap: 14px; }
  .visual-card { background: rgba(124,109,242,0.12); border: 1px solid rgba(165,148,253,0.35); border-radius: 12px; padding: 18px; }
  .visual-card strong { color: #a594fd; display: block; margin-bottom: 10px; }
  .visual-card p, .visual-card li { color: #e2e8f0; line-height: 1.45; }
  .visual-stat { width: 100%; display: grid; grid-template-columns: 42% 1fr; gap: 24px; align-items: center; }
  .visual-value { color: #a594fd; font-size: 64px; font-weight: 900; }
  .visual-quote { width: 100%; padding: 28px; text-align: center; color: #f1f5f9; font-size: 28px; font-style: italic; line-height: 1.45; }
  .visual-steps { width: 100%; display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; }
  .visual-step { text-align: center; }
  .visual-step .step-number { margin: 0 auto 10px; width: 28px; height: 28px; border-radius: 50%; background: #7c6df2; display: grid; place-items: center; font-weight: 800; }
  .slide-footer {
    display: flex;
    justify-content: space-between;
    align-items: center;
    border-top: 1px solid rgba(255, 255, 255, 0.08);
    padding-top: 14px;
    font-size: 12px;
    color: #64748b;
  }
  .notes-drawer {
    position: fixed;
    bottom: 60px;
    left: 50%;
    transform: translateX(-50%);
    width: 90%;
    max-width: 900px;
    background: #1e1b4b;
    border: 1px solid #7c6df2;
    border-radius: 12px;
    padding: 16px 20px;
    box-shadow: 0 10px 30px rgba(0,0,0,0.5);
    z-index: 50;
    display: none;
  }
  .notes-drawer.open { display: block; }
  .notes-title { font-size: 13px; font-weight: 700; color: #a594fd; margin-bottom: 6px; }
  .notes-content { font-size: 14px; color: #f1f5f9; line-height: 1.5; }
  footer {
    background: #0f172a;
    padding: 12px 24px;
    display: flex;
    justify-content: space-between;
    align-items: center;
    border-top: 1px solid rgba(255, 255, 255, 0.05);
  }
  .nav-buttons { display: flex; gap: 10px; align-items: center; }
  .progress-bar {
    position: absolute;
    bottom: 0;
    left: 0;
    height: 4px;
    background: #7c6df2;
    transition: width 0.3s ease;
  }
  @media print {
    body { background: #fff; color: #000; overflow: visible; }
    header, footer, .controls, .notes-drawer { display: none !important; }
    .slide-container {
      box-shadow: none;
      border: 1px solid #ccc;
      page-break-after: always;
      margin-bottom: 30px;
      aspect-ratio: auto;
      background: #fff !important;
      color: #000 !important;
    }
    .slide-title, .slide-bullets li { color: #000 !important; }
  }
</style>
</head>
<body>

<header>
  <div class="brand">
    <span>📊</span>
    <span>${escapeXml(deckTitle)}</span>
  </div>
  <div class="controls">
    <button onclick="toggleNotes()">🎙️ Lời giảng (Notes)</button>
    <button onclick="toggleFullScreen()">⛶ Toàn màn hình</button>
    <button onclick="window.print()">🖨️ In Slide</button>
  </div>
</header>

<main>
  <div class="slide-container" id="slideBox">
    <span class="slide-badge" id="slideIndexBadge">1 / ${slides.length}</span>
    <div>
      <h1 class="slide-title" id="slideTitle"></h1>
      <div class="slide-subtitle" id="slideSubtitle"></div>
    </div>
    <div class="slide-visual" id="slideVisual"></div>
    <ul class="slide-bullets" id="slideBullets"></ul>
    <div class="slide-takeaway" id="slideTakeaway" style="display:none;"></div>
    <div class="slide-footer">
      <span>${escapeXml(courseTitle)}</span>
      <span id="footerSlideCount"></span>
    </div>
    <div class="progress-bar" id="progressBar"></div>
  </div>
</main>

<div class="notes-drawer" id="notesDrawer">
  <div class="notes-title">🎙️ Ghi chú người thuyết trình (Speaker Notes):</div>
  <div class="notes-content" id="notesContent"></div>
</div>

<footer>
  <div style="font-size: 13px; color: #94a3b8;">
    Dùng phím <strong>←</strong> / <strong>→</strong> hoặc <strong>Space</strong> để chuyển slide
  </div>
  <div class="nav-buttons">
    <button onclick="prevSlide()">← Trước</button>
    <span id="counter" style="font-weight: 700; font-size: 14px; min-width: 60px; text-align: center;">1 / ${slides.length}</span>
    <button onclick="nextSlide()">Tiếp →</button>
  </div>
</footer>

<script>
  const slides = ${JSON.stringify(slides)};
  let currentIndex = 0;

  function formatInlineMarkdown(text) {
    if (!text) return '';
    var esc = String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return esc
      .replace(/\\*\\*\\*([^*]+?)\\*\\*\\*/g, '<strong style="font-weight: 600; font-style: italic; color: #ffffff;">$1</strong>')
      .replace(/\\*\\*([^*]+?)\\*\\*/g, '<strong style="font-weight: 600; color: #ffffff;">$1</strong>')
      .replace(new RegExp('\\\\x60([^\\\\x60]+?)\\\\x60', 'g'), '<code style="background: rgba(255,255,255,0.1); padding: 1px 5px; border-radius: 4px; font-family: monospace;">$1</code>')
      .replace(/\\*([^*]+?)\\*/g, '<em>$1</em>');
  }

  function renderSlide() {
    if (!slides || slides.length === 0) return;
    const slide = slides[currentIndex];
    document.getElementById('slideTitle').textContent = slide.title || '';
    
    const subEl = document.getElementById('slideSubtitle');
    if (slide.subtitle) {
      subEl.innerHTML = formatInlineMarkdown(slide.subtitle);
      subEl.style.display = 'block';
    } else {
      subEl.style.display = 'none';
    }

    const bulletsList = document.getElementById('slideBullets');
    bulletsList.innerHTML = '';
    const visualEl = document.getElementById('slideVisual');
    visualEl.innerHTML = '';
    const visual = slide.visual || {};
    if (slide.layout === 'comparison' && (visual.leftLabel || visual.rightLabel)) {
      visualEl.innerHTML = '<div class="visual-grid">' +
        [['leftLabel', 'leftPoints'], ['rightLabel', 'rightPoints']].map(function(pair) {
          var label = visual[pair[0]] || '';
          var points = visual[pair[1]] || [];
          return '<div class="visual-card"><strong>' + formatInlineMarkdown(label) + '</strong><ul>' +
            points.map(function(point) { return '<li>' + formatInlineMarkdown(point) + '</li>'; }).join('') +
            '</ul></div>';
        }).join('') + '</div>';
    } else if ((slide.layout === 'timeline' || slide.layout === 'process') && visual.steps && visual.steps.length) {
      visualEl.innerHTML = '<div class="visual-steps">' + visual.steps.slice(0, 4).map(function(step, index) {
        return '<div class="visual-step"><div class="step-number">' + (index + 1) + '</div><strong>' +
          formatInlineMarkdown(step.label) + '</strong><p>' + formatInlineMarkdown(step.description || '') + '</p></div>';
      }).join('') + '</div>';
    } else if (slide.layout === 'stat' && visual.value) {
      visualEl.innerHTML = '<div class="visual-stat"><div class="visual-value">' + formatInlineMarkdown(visual.value) +
        '</div><div class="visual-card"><p>' + formatInlineMarkdown(visual.context || slide.keyTakeaway || '') + '</p></div></div>';
    } else if (slide.layout === 'quote' && visual.quote) {
      visualEl.innerHTML = '<div class="visual-quote">“' + formatInlineMarkdown(visual.quote) +
        (visual.author ? '<br><small>— ' + formatInlineMarkdown(visual.author) + '</small>' : '') + '</div>';
    } else if ((slide.layout === 'cards' || slide.layout === 'quadrant') && (visual.cards || visual.quadrants)) {
      var cards = visual.cards || visual.quadrants;
      visualEl.innerHTML = '<div class="visual-grid">' + cards.slice(0, 4).map(function(card) {
        return '<div class="visual-card"><strong>' + formatInlineMarkdown(card.title) + '</strong><p>' +
          formatInlineMarkdown(card.description || '') + '</p></div>';
      }).join('') + '</div>';
    }
    if (visualEl.innerHTML) bulletsList.style.display = 'none'; else bulletsList.style.display = 'flex';
    (slide.bullets || []).forEach(bullet => {
      const li = document.createElement('li');
      li.innerHTML = formatInlineMarkdown(bullet);
      bulletsList.appendChild(li);
    });

    const takeawayEl = document.getElementById('slideTakeaway');
    if (slide.keyTakeaway) {
      takeawayEl.innerHTML = '<strong>Điểm cốt lõi:</strong> ' + formatInlineMarkdown(slide.keyTakeaway);
      takeawayEl.style.display = 'block';
    } else {
      takeawayEl.style.display = 'none';
    }

    const notesEl = document.getElementById('notesContent');
    notesEl.innerHTML = formatInlineMarkdown(slide.notes || 'Không có ghi chú cho slide này.').replace(/\n/g, '<br/>');

    const pageStr = (currentIndex + 1) + ' / ' + slides.length;
    document.getElementById('slideIndexBadge').textContent = pageStr;
    document.getElementById('footerSlideCount').textContent = pageStr;
    document.getElementById('counter').textContent = pageStr;

    const progressPct = ((currentIndex + 1) / slides.length) * 100;
    document.getElementById('progressBar').style.width = progressPct + '%';
  }

  function nextSlide() {
    if (currentIndex < slides.length - 1) {
      currentIndex++;
      renderSlide();
    }
  }

  function prevSlide() {
    if (currentIndex > 0) {
      currentIndex--;
      renderSlide();
    }
  }

  function toggleNotes() {
    const el = document.getElementById('notesDrawer');
    el.classList.toggle('open');
  }

  function toggleFullScreen() {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen();
    } else {
      if (document.exitFullscreen) {
        document.exitFullscreen();
      }
    }
  }

  document.addEventListener('keydown', e => {
    if (e.key === 'ArrowRight' || e.key === ' ' || e.key === 'PageDown') {
      e.preventDefault();
      nextSlide();
    } else if (e.key === 'ArrowLeft' || e.key === 'PageUp') {
      e.preventDefault();
      prevSlide();
    } else if (e.key === 'f' || e.key === 'F') {
      toggleFullScreen();
    } else if (e.key === 'n' || e.key === 'N') {
      toggleNotes();
    }
  });

  renderSlide();
</script>
</body>
</html>`;

  const blob = new Blob([htmlContent], { type: 'text/html;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  const sanitizedName = (deck.title || courseTitle || 'Slide_Thuyet_Trinh')
    .replace(/[^a-zA-Z0-9_\u00C0-\u024F\u1E00-\u1EFF]/g, '_')
    .slice(0, 40);
  a.download = `${sanitizedName}_TrinhChieu.html`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/**
 * Formats slide deck into clean markdown text for clipboard copying.
 */
export function formatSlideDeckText(deck: SlideDeckData, courseTitle: string): string {
  const slides = deck.slides || [];
  let out = `# ${deck.title || `BÀI GIẢNG: ${courseTitle.toUpperCase()}`}\n\n`;

  slides.forEach((s, idx) => {
    out += `## Slide ${idx + 1}: ${s.title}\n`;
    if (s.subtitle) out += `*${s.subtitle}*\n\n`;
    (s.bullets || []).forEach(b => {
      out += `- ${b}\n`;
    });
    if (s.keyTakeaway) {
      out += `\n> 💡 **Điểm cốt lõi:** ${s.keyTakeaway}\n`;
    }
    if (s.notes) {
      out += `\n**🎙️ Lời giảng/Ghi chú:** ${s.notes}\n`;
    }
    out += `\n---\n\n`;
  });

  return out;
}
