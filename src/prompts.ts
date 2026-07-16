/**
 * 视觉模型提示词模板与模式选择。
 *
 * 这里集中维护 vision-mcp 的识图模式：
 * - auto：先自动判断设计图、原型图、bug 截图或普通图片，再按类型输出结构化结果。
 * - design_rebuild：面向设计图/页面截图还原。
 * - prototype_understanding：面向原型图/线框图理解。
 * - bug_screenshot：面向测试反馈/异常截图分析。
 * - general：普通图片描述。
 *
 * MCP 工具和图片代理都通过 buildImageDescriptionPrompt 生成最终发给视觉模型的 prompt。
 * 用户传入的 prompt 只作为当前任务补充，会附加到模式模板后，不替代模式模板。
 */
export const IMAGE_DESC_MODES = [
  "auto",
  "design_rebuild",
  "prototype_understanding",
  "bug_screenshot",
  "general",
] as const;

export type ImageDescMode = (typeof IMAGE_DESC_MODES)[number];

export const DEFAULT_IMAGE_DESC_MODE: ImageDescMode = normalizeImageDescMode(
  process.env.IMAGE_DESC_MODE
);

export const LEGACY_DEFAULT_PROMPT = "请详细描述这张图片的内容。";

const COMMON_RULES = `通用要求：
- 先给出 "image_type" 和 "confidence"，如果不确定要说明原因。
- 所有可见文字必须尽量逐字 OCR，不能改写、总结或翻译。
- 区分确定事实和推测；看不清的内容标为 unclear，不要硬猜。
- 优先输出对纯文本大模型可执行的信息：层级、位置、尺寸、颜色、间距、状态、异常线索。
- 使用 Markdown 结构化输出，避免泛泛的自然语言描述。`;

const DESIGN_REBUILD_PROMPT = `你是 UI 设计图解析器。请把图片转成可供纯文本大模型还原界面的规格说明。

输出顺序：
1. image_type: design_rebuild
2. canvas: 设备/页面类型、宽高比例、背景色、整体布局方式。
3. layout_tree: 从上到下、从左到右列出区域、容器、组件层级。
4. elements: 对每个关键元素说明：
   - 类型：导航、标题、文本、按钮、输入框、图片、图标、卡片、表格、列表、标签页、弹窗等
   - 位置：相对区域和相对坐标，例如 top-left / center / right column / header area
   - 尺寸：估算宽高或大/中/小
   - 文本：逐字 OCR
   - 样式：背景色、文字色、边框、圆角、阴影、透明度、字号、字重、对齐
   - 间距：padding、margin、gap 的相对关系
   - 状态：选中、禁用、激活、错误、加载等
5. rebuild_notes: 给后续纯文本模型还原页面时最重要的约束。
6. uncertainties: 不确定或看不清的地方。

${COMMON_RULES}`;

const PROTOTYPE_PROMPT = `你是产品原型图/线框图解析器。请把图片转成适合理解信息架构和交互的规格说明。

输出顺序：
1. image_type: prototype_understanding
2. screen_purpose: 页面目标和用户任务。
3. layout_structure: 页面区域、模块顺序、导航关系、主次信息。
4. components: 表单字段、按钮、菜单、列表、卡片、占位图、流程节点等。
5. interactions: 可点击元素、输入行为、跳转/提交/筛选/展开等交互意图。
6. copy_and_labels: 所有可见文案和字段名，尽量逐字 OCR。
7. product_notes: 对需求理解、页面逻辑、边界状态有帮助的线索。
8. uncertainties: 不确定或看不清的地方。

${COMMON_RULES}`;

const BUG_SCREENSHOT_PROMPT = `你是测试截图分析器。请从图片中提取 bug 分析所需的可见证据。

输出顺序：
1. image_type: bug_screenshot
2. visible_problem: 截图中可见的异常现象，例如报错、错位、遮挡、空白、加载失败、数据异常、状态异常。
3. error_text: 所有错误文案、状态码、弹窗、toast、控制台信息，逐字 OCR。
4. affected_area: 出问题的页面区域、组件、按钮、表单项、列表项或数据。
5. expected_vs_actual_inference: 只能基于截图做谨慎推断，不知道期望时要说明 unknown。
6. reproduction_clues: 从截图可见的账号、环境、URL、时间、筛选条件、输入值、设备线索。
7. severity_clues: 影响范围和风险线索。
8. uncertainties: 无法仅凭截图确认的信息。

${COMMON_RULES}`;

const GENERAL_PROMPT = `请详细、准确地描述这张图片。

${COMMON_RULES}`;

const AUTO_PROMPT = `你是图片类型自动识别与 UI/测试截图解析器。请先根据图片内容自动分类，再按最合适的模板输出。

分类规则：
- design_rebuild：高保真 UI 设计图、完整页面截图、App/Web 界面、Figma 风格视觉稿，适合按图还原界面。
- prototype_understanding：低保真原型图、线框图、灰阶占位框、流程图式页面、强调结构和交互而不是视觉样式。
- bug_screenshot：包含明显报错、异常弹窗、红色错误、失败状态、错位遮挡、空白页、控制台/日志、测试反馈截图等。
- general：不属于 UI、原型或 bug 截图的普通图片。

如果同时像设计图和 bug 截图：只要有明显异常、报错或错误状态，优先 bug_screenshot。
如果分类不确定但图片是 UI 页面，默认 design_rebuild，并在 uncertainties 里说明可能性。

按分类输出：
- design_rebuild：输出 canvas、layout_tree、elements、rebuild_notes、uncertainties，重点给纯文本模型还原界面所需的层级、位置、尺寸、颜色、字号、间距、状态和完整 OCR。
- prototype_understanding：输出 screen_purpose、layout_structure、components、interactions、copy_and_labels、product_notes、uncertainties，重点理解结构和交互。
- bug_screenshot：输出 visible_problem、error_text、affected_area、expected_vs_actual_inference、reproduction_clues、severity_clues、uncertainties，重点提取可见异常和复现线索。
- general：输出准确、详细的图片描述和可见文字。

${COMMON_RULES}`;

function withUserPrompt(basePrompt: string, userPrompt?: string): string {
  const trimmed = userPrompt?.trim();
  if (!trimmed || trimmed === LEGACY_DEFAULT_PROMPT) {
    return basePrompt;
  }
  return `${basePrompt}

用户当前任务/问题：
${trimmed}

如果用户任务与自动分类有冲突，以用户任务为准；如果用户任务只是补充问题，请在对应模板中重点回答。`;
}

export function normalizeImageDescMode(value: unknown): ImageDescMode {
  const raw = String(value || "auto").trim().toLowerCase();
  switch (raw) {
    case "auto":
      return "auto";
    case "design":
    case "ui":
    case "ui_spec":
    case "design_rebuild":
    case "rebuild":
      return "design_rebuild";
    case "prototype":
    case "wireframe":
    case "prototype_understanding":
      return "prototype_understanding";
    case "bug":
    case "error":
    case "screenshot_bug":
    case "bug_screenshot":
      return "bug_screenshot";
    case "general":
    default:
      return raw === "general" ? "general" : "auto";
  }
}

export function buildImageDescriptionPrompt(
  mode: ImageDescMode,
  userPrompt?: string
): string {
  switch (mode) {
    case "design_rebuild":
      return withUserPrompt(DESIGN_REBUILD_PROMPT, userPrompt);
    case "prototype_understanding":
      return withUserPrompt(PROTOTYPE_PROMPT, userPrompt);
    case "bug_screenshot":
      return withUserPrompt(BUG_SCREENSHOT_PROMPT, userPrompt);
    case "general":
      return withUserPrompt(GENERAL_PROMPT, userPrompt);
    case "auto":
    default:
      return withUserPrompt(AUTO_PROMPT, userPrompt);
  }
}
