/** Evidence-grounded editorial checks run inside the existing configurable reviewers. */
export const DRAMATURGY_REVIEW_PROMPT = `
【cinematic-v1 叙事审核】原最外层 review.passed、review.issues、review.evidence、review.checks 只表示史实、动作可执行性结论。另输出 dramaturgyReview，两类结论分别保存，不把叙事问题伪装成史料错误。
两层覆盖分别核对：最外层 review.evidence 是史料引证，每个候选场景都必须覆盖，任何叙事免证或 issues 定位修正均不能免除它。同一史料确实支持多场时，itemIds 共享只允许用于最外层 review.evidence，由程序逐场展开。dramaturgyReview.evidence 是候选自身声画引文，只接受单场 itemId；dramaturgyReview.uncovered 只声明叙事承担关系，不替代最外层 review.evidence。本块以下 evidence/issues 规则都明确属于 dramaturgyReview，不能据此删除任何场景的事实引证。
dramaturgyReview={version:"dramaturgy-v1",passed:boolean,orientation:{status:"passed|failed|not_applicable",reason,evidenceRefs:[0]},dramaticProgression:{status,reason,evidenceRefs},characterDistinction:{status,reason,evidenceRefs},payoff:{status,reason,evidenceRefs},evidence:[{itemId,beatId?,path,quote,finding}],issues:[{code,itemId,beatId?,path,quote,problem,repair,scope:"scene|dramaticScene|episode"}],warnings:[],uncovered:[{itemId,reason,coveredBy}]?,repairScope:"scene|dramaticScene|episode"}。
dramaturgyReview.evidence 与 dramaturgyReview.issues 必须逐字引用当前候选中实际可拍的声画内容，path 为从候选根开始的点路径（例 scenes.0.requiredBeats.0.observable.visual.0、requiredBeats.0.observable.audio.0、beatDramaturgy.0.visual.0、audioText、videoPrompt），不得引用 cast 人物名单、purpose、stateChange、shotIntent 等元数据或幕后意图证明声画已交代。itemId必须是当前候选场景/镜头id，beatId必须属该场/镜。叙事逐场覆盖是二选一：要么该场至少一项 dramaturgyReview.evidence 声画引文，要么在 dramaturgyReview.uncovered 中逐场声明 {itemId,reason,coveredBy}——coveredBy 必须是 dramaturgyReview.evidence 已经引用过的、与本场同属一个 dramaticSceneId 的另一短段，reason 写清该短段如何承担本场的声画义务。声画证据不接受 itemIds 共享，程序也不猜测任何证据适用于哪些场；候选首场、末场以及 episodeDrama.openingPromise/payoff 节拍所属场次必须给 dramaturgyReview.evidence，不能叙事免证；每个 dramaticSceneId 至少要有一条 dramaturgyReview.evidence 落点。既无落点又无声明的场次使叙事报告失效，这只修报告，不得回写候选。长清单最容易漏在中间：先从 candidate.scenes 第一场到最后一场按原顺序逐场落 dramaturgyReview.evidence，一条先服务一场，quote 逐字复制该场某条 requiredBeats[].observable.visual[0] 或 audio[0] 的原文，finding 写清该声画让观众实际看到或听到什么；写完核对 dramaturgyReview.evidence 与 dramaturgyReview.uncovered 的 itemId 合起来等于全部场次 id，缺哪一场就地补哪一场，不要留给驳回，覆盖完再写四个分项与 dramaturgyReview.issues。四个分项的 evidenceRefs 是 dramaturgyReview.evidence 数组零基索引，同一条声画引文可以被多个分项同时复用；证据条数少于分项数是正常情况，绝不需要为凑满每个分项而另造新证据。失效或缺漏报告只修被点名条目；保留未被否定的 review.evidence 与 dramaturgyReview.evidence，禁止因此删场或回写候选。
duration-v2候选还可逐字引用 pacing.beats.0.textOrVocalization 或 pacing.beats.0.performanceInstruction 等带完整索引的实际声画正文；beatId仍填写该项sourceBeatId对应的原剧情节拍，不填拆分后的执行节拍id。不得引用pacing.beats整个对象数组、完成态/证据锚点元数据、依赖或预算替代声画正文。声画叶子可引用只表示候选确实写了它，不证明同时性、先后关系或原义务已满足；原文要求边走边唱时仍须核对两者实际编排重叠，先走后唱仍应拒绝。
检查：观众通过声画能认清谁处于何种困境；主冲突的应对与反制是否改变局面；人物应对有无可辨差异；整集开场承诺是否得到结尾回应。scene/shot只评当前已分配义务，后续回应不能要求提前拍完。少量必要旁白、克制静态机位、没有反转或笑点都可以通过。
【四个分项的 status 与 evidenceRefs 硬规则】orientation、dramaticProgression、characterDistinction、payoff 四项都遵守同一规则，没有例外：判 passed 或 failed 时 evidenceRefs 必须是至少含一个有效零基索引的非空数组（可复用其他分项已引用的索引）；当前候选根本没有分配该义务时（例如单镜不必重复交代前镜已完成的处境，或结尾回应尚未到本镜），必须如实判 not_applicable 并在 reason 说明为何不适用，此时 evidenceRefs 省略或写 []。禁止用 passed 配空 evidenceRefs 表达“没问题但无证据可引”——这正是最常见的报告失效原因；也禁止为了凑索引而虚构证据。not_applicable 是如实结论，不算降低审核标准，更不算编造通过。
提交前逐项自查：四项 status 是否都在 passed/failed/not_applicable 中；每项 reason 是否非空且具体；每个非 not_applicable 分项是否都至少有一个落在 0 到 dramaturgyReview.evidence.length-1 区间的索引；每场是否至少一条 dramaturgyReview.evidence 或在 dramaturgyReview.uncovered 中声明、每个 dramaticSceneId 是否至少一条 dramaturgyReview.evidence 落点、dramaturgyReview.uncovered 的 coveredBy 是否已被 dramaturgyReview.evidence 引用且与本场同属一个 dramaticSceneId；每条 dramaturgyReview.evidence 的 path/quote 是否能在候选声画原文中逐字找到；dramaturgyReview.issues 的 code 是否都在允许清单内；dramaturgyReview.repairScope 是否等于 dramaturgyReview.issues 的最大范围。最后独立核对最外层 review.evidence 仍覆盖每一个候选场景，叙事免证不能省略事实引证。发现任一项不满足，就地修正报告后再输出，不要输出后再等驳回。
dramaturgyReview.issues 可触发修复的code仅为 missing_orientation、repeated_information、missing_response、lost_approved_beat、indistinct_character_action、missing_payoff、missing_causal_change。拒绝需明确现有声画缺失的信息、重复的义务或被删除的已批准节拍，并给最小修复范围；同一立场但增加新信息/选择/关系变化不是重复。style_preference等审美偏好只能放 dramaturgyReview.warnings。不能用“不够燃/电影感不足/没有反转”触发重写。
dramaturgyReview.repairScope 为 dramaturgyReview.issues 中的最大范围。优先scene，跨一场完整戏用dramaticScene；只有大纲本集核心主线缺失可用episode，且媒体生产前既有3次总尝试中最多重构一次。重构保留historicalLocks、历史主体/因果和原候选。不得为影视感编造未知核心政治动机。
【cinematic-v1 叙事审核结束】`;

export const DRAMATURGY_REVIEW_START = '【cinematic-v1 叙事审核】';
export const DRAMATURGY_REVIEW_END = '【cinematic-v1 叙事审核结束】';
const SOURCE_QUOTE_START = '【史料引文复制规则 v1】';

/** Refresh the bounded dramaturgy instruction block in an already-deployed reviewer
 * prompt. The legacy block had no end marker, so it is delimited by the source-quote
 * block that always follows it; anything else is left alone rather than guessed. */
export function refreshDramaturgyReviewPrompt(prompt: string) {
  const block = DRAMATURGY_REVIEW_PROMPT.trim();
  if (prompt.includes(DRAMATURGY_REVIEW_END)) {
    if (!prompt.includes(DRAMATURGY_REVIEW_START)) throw Error('Cannot safely refresh incomplete dramaturgy instruction block');
    return prompt.replace(new RegExp(DRAMATURGY_REVIEW_START + '[\\s\\S]*?' + DRAMATURGY_REVIEW_END), block);
  }
  const start = prompt.indexOf(DRAMATURGY_REVIEW_START);
  if (start < 0) return prompt + '\n' + block;
  const next = prompt.indexOf(SOURCE_QUOTE_START, start);
  if (next < 0) throw Error('Cannot safely refresh unbounded legacy dramaturgy block; preserve custom reviewer prompt');
  return prompt.slice(0, start) + block + '\n' + prompt.slice(next);
}

/** Self contained so it can also be embedded in editable sandboxed code nodes. */
export function validateDramaturgyReview(candidate: Record<string, unknown>, value: unknown) {
  const obj = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
  const rows = (v: unknown) => Array.isArray(v) ? v.map(obj) : [];
  // One report routinely carries several independent format defects. Reporting only
  // the first made every retry spend its whole budget discovering the next defect,
  // so a two-defect report could never converge under maxAttempts=2. Collect all of
  // them and throw once; genuine bugs still propagate because only ABORT is caught.
  const problems: string[] = [];
  const ABORT = Symbol('dramaturgy-report-problem');
  const invalid = (reason: string): never => { problems.push(reason); throw ABORT; };
  const unit = (run: () => void) => { try { run(); } catch (error) { if (error !== ABORT) throw error; } };
  const review = { ...obj(value) };
  // Quote glyphs are formatting, not content. The outline writes its sound/image lines with half-width
  // punctuation (16 of 17 citable leaves in record-l2t6gi used “,”“?”), while a reviewer transcribing
  // the very same sentence reaches for the full-width “，”“？”. Comparing those bytes made every
  // sentence-punctuation quote ground in 0 places, and four paid re-reviews resubmitted the identical
  // defect list. Fold each variant onto one glyph — 1:1, so length, word order, digits and spacing stay
  // exact and a paraphrase is still a defect — and keep the originals untouched in the returned report.
  const comparableQuote = (text: string) => text.normalize('NFKC')
    .replace(/[“”「」『』《》〈〉]/g, '"').replace(/[‘’]/g, "'")
    .replace(/[。]/g, '.').replace(/[、]/g, ',');
  const includesQuote = (actual: string, quote: string) => comparableQuote(actual).includes(comparableQuote(quote));
  const items = Array.isArray(candidate.scenes) ? rows(candidate.scenes) : [candidate];
  const evidence = rows(review.evidence).map(row => ({ ...row })), issues = rows(review.issues).map(row => ({ ...row }));
  // Every string the rules allow a citation to point at, with the item that owns it. Used only
  // to repair a locator the reviewer mistyped while its quote is real (see normalizeLocator).
  const pathValue = (path: string) => path.split('.').reduce((current: unknown, key: string) => current && typeof current === 'object' ? (current as Record<string, unknown>)[key] : undefined, candidate);
  const groundable: { itemId: string; path: string; value: string }[] = [];
  const textRows = (v: unknown) => Array.isArray(v) ? v : [];
  const timingBody = (item: Record<string, unknown>, local: string) => {
    const pacing = obj(item.pacing), match = /^pacing\.beats\.(\d+)\.(textOrVocalization|performanceInstruction)$/.exec(local);
    if (pacing.version !== 'duration-v2' || !match) return undefined;
    const beat = rows(pacing.beats)[Number(match[1])];
    const sourceBeats = [...rows(item.requiredBeats), ...rows(item.beatDramaturgy)];
    return beat && typeof beat.sourceBeatId === 'string' && beat.sourceBeatId.trim()
      && sourceBeats.some(source => (source.id ?? source.beatId) === beat.sourceBeatId)
      && ['action', 'reaction', 'speech', 'vocalization'].includes(String(beat.kind)) ? beat : undefined;
  };
  items.forEach((item, index) => {
    const head = Array.isArray(candidate.scenes) ? 'scenes.' + index + '.' : '';
    const itemId = String(item.id ?? '');
    const scalar = (suffix: string, value: unknown) => { if (typeof value === 'string' && value.trim()) groundable.push({ itemId, path: head + suffix, value }); };
    // Indexed leaves only, exactly what the citation rules accept as a final locator. rows() is
    // not usable here: it maps every element through obj() and silently erases plain strings.
    const list = (suffix: string, values: unknown) => textRows(values).forEach((value, position) => { if (typeof value === 'string' && value.trim()) groundable.push({ itemId, path: head + suffix + '.' + position, value }); });
    scalar('audioText', item.audioText);
    scalar('videoPrompt', item.videoPrompt);
    rows(item.requiredBeats).forEach((beat, beatIndex) => {
      const observable = obj(beat.observable);
      list('requiredBeats.' + beatIndex + '.observable.visual', observable.visual);
      list('requiredBeats.' + beatIndex + '.observable.audio', observable.audio);
      list('requiredBeats.' + beatIndex + '.mustShow', beat.mustShow);
    });
    rows(item.beatDramaturgy).forEach((beat, beatIndex) => {
      list('beatDramaturgy.' + beatIndex + '.visual', beat.visual);
      list('beatDramaturgy.' + beatIndex + '.audio', beat.audio);
    });
    rows(obj(item.pacing).beats).forEach((beat, beatIndex) => {
      for (const field of ['textOrVocalization', 'performanceInstruction']) {
        const suffix = 'pacing.beats.' + beatIndex + '.' + field;
        if (timingBody(item, suffix)) scalar(suffix, beat[field]);
      }
    });
  });
  const envelope: string[] = [];
  if (typeof review.passed !== 'boolean') envelope.push('passed 必须是布尔值');
  if (review.version !== 'dramaturgy-v1') envelope.push('version 必须是 "dramaturgy-v1"，当前是 ' + JSON.stringify(review.version));
  if (!Array.isArray(review.evidence)) envelope.push('evidence 必须是数组');
  else if (!evidence.length) envelope.push('evidence 不能为空，每个场至少一项声画证据');
  if (!Array.isArray(review.issues)) envelope.push('issues 必须是数组，无问题时写 []');
  if (!Array.isArray(review.warnings)) envelope.push('warnings 必须是数组，无建议时写 []');
  if (review.uncovered !== undefined && !Array.isArray(review.uncovered)) envelope.push('uncovered 必须是数组，无需免证时整个字段省略或写 []');
  if (envelope.length) throw Error('REVIEW_RESULT_INVALID: 叙事报告 缺少独立结论或声画证据：' + envelope.join('；'));
  // A mistyped locator is bookkeeping, not a missing observation. When the declared path cannot
  // hold the quote but exactly one rule-legal string in the candidate does, adopt that locator.
  // An ambiguous or absent quote keeps the original defect, so the gate still never guesses which
  // segment a citation proves and every segment still has to be covered by its own grounded row.
  const normalizeLocator = (row: Record<string, unknown>) => {
    const declared = String(row.path), quote = String(row.quote);
    const value = pathValue(declared);
    const holds = typeof value === 'string' ? includesQuote(value, quote)
      : Array.isArray(value) && value.some(entry => typeof entry === 'string' && includesQuote(entry, quote));
    if (holds) return;
    const matches = groundable.filter(entry => includesQuote(entry.value, quote));
    if (matches.length !== 1) return;
    row.path = matches[0].path;
    if (matches[0].itemId) row.itemId = matches[0].itemId;
  };
  const ground = (row: Record<string, unknown>, label: string) => {
    if (typeof row.path !== 'string' || typeof row.quote !== 'string' || !row.quote.trim()) invalid(label + '定位字段缺失：path 与 quote 必须是非空字符串');
    // An explicit timing path must identify its own existing body leaf. Never
    // reinterpret an array, metadata field or invented index as another quote.
    if (!/^(?:scenes\.\d+\.)?pacing(?:\.|$)/.test(String(row.path))) normalizeLocator(row);
    let path = String(row.path);
    // The path is the grounded locator (its quote is verified against the candidate below),
    // so derive the scene index from it instead of trusting itemId. Reviewers routinely copy a
    // line's real path but mislabel itemId (e.g. scene-03's dialogue tagged scene-05); telling
    // them to rewrite the path only produced a second defect, because the quote is not in the
    // mislabeled scene. Trust the grounded path, correct itemId to it, and let the per-scene
    // coverage check below still hold every scene accountable for its own evidence.
    const pathIndex = Array.isArray(candidate.scenes) ? Number(/^scenes\.(\d+)(?:\.|$)/.exec(path)?.[1] ?? NaN) : NaN;
    const itemIndex = Number.isInteger(pathIndex) && pathIndex >= 0 && pathIndex < items.length ? pathIndex : items.findIndex(item => item.id === row.itemId);
    if (itemIndex < 0) invalid(label + '定位字段缺失：itemId 必须是当前候选中的场景/镜头 id（当前 ' + JSON.stringify(row.itemId) + '，候选为 ' + JSON.stringify(items.map(item => item.id)) + '），path 必须指向候选内场景');
    const item = items[itemIndex];
    if (item && row.itemId !== item.id) row.itemId = item.id;
    const prefix = Array.isArray(candidate.scenes) ? 'scenes.' + itemIndex + '.' : '';
    if (!path.startsWith(prefix)) invalid(label + '证据路径不属于所指场景：path 必须以 ' + JSON.stringify(prefix || '(单场无需前缀)') + ' 开头，当前是 ' + JSON.stringify(path));
    let local = path.slice(prefix.length);
    if (/^(?:requiredBeats\.\d+\.observable\.(?:visual|audio)|beatDramaturgy\.\d+\.(?:visual|audio))$/.test(local)) {
      const values = path.split('.').reduce<unknown>((current, key) => current && typeof current === 'object' ? (current as Record<string, unknown>)[key] : undefined, candidate);
      if (!Array.isArray(values) || values.some(value => typeof value !== 'string')) invalid(label + '数组证据必须指向声画字符串数组：' + path);
      const matches = (values as string[]).flatMap((value, index) => includesQuote(value, String(row.quote)) ? [index] : []);
      if (matches.length !== 1) invalid(label + '数组证据引文必须唯一匹配一个声画元素，歧义不能补写索引：' + path + ' 命中 ' + matches.length + ' 处');
      path += '.' + matches[0]; row.path = path; local = path.slice(prefix.length);
    }
    const timingBeat = timingBody(item, local);
    const invalidBodyPath = (reason: string): never => {
      const available = groundable.filter(entry => entry.itemId === String(item.id)).slice(0, 6)
        .map(entry => ({ path: entry.path, quote: entry.value.slice(0, 160) }));
      return invalid(reason + '；所属场景 ' + String(item.id) + '，错误字段 dramaturgyReview.' + label.trim()
        + '，原引用 ' + JSON.stringify(row.quote)
        + '；该场可引用的真实声画原文（长句仅列原文前160字）=' + JSON.stringify(available)
        + '。这些定位候选不自动证明当前 problem；cast、purpose、状态或预算等元数据不能代替实际声画。重新核对该场 observable/audioText/videoPrompt，只有确有声画依据的实质问题才保留在 issues；无法证明的推测移入 warnings 并同步分项与最终结论，不能仅换成合法 path 来维护无依据的拒绝。'
        + '本次只修被点名的报告条目，保留未被否定的最外层 review.evidence（每场史料引证）与 dramaturgyReview.evidence（声画落点）；不得删除该场、候选内容或任一层证据来消除定位错误。dramaturgyReview.uncovered 只处理叙事覆盖，不能替代最外层逐场史料引证。');
    };
    if (local.startsWith('pacing.') && !timingBeat) invalidBodyPath(label + 'duration-v2证据须为绑定原剧情节拍的pacing.beats.N.textOrVocalization或performanceInstruction正文叶子：' + path);
    if (!timingBeat && !/^(?:requiredBeats\.\d+\.(?:observable\.(?:visual|audio)\.\d+|mustShow\.\d+)|beatDramaturgy\.\d+\.(?:visual|audio)\.\d+|audioText|videoPrompt)$/.test(local)) invalidBodyPath(label + '证据必须定位实际 beat/action/dialogue，不能用幕后意图：' + path);
    const parts = path.split('.');
    const actual = parts.reduce<unknown>((current, key) => current && typeof current === 'object' ? (current as Record<string, unknown>)[key] : undefined, candidate);
    if (typeof actual !== 'string' || !includesQuote(actual, String(row.quote))) {
      // A locator that misses its quote has two very different causes — the reviewer pointed at the
      // wrong line, or it restated the line. Saying only “不在候选声画原文中: path” named neither
      // the cited text nor the real one, so every re-review copied its own previous quote back and the
      // branch died at 异常复核达到上限 with four byte-identical defect lists. Print both sides and the
      // places that do hold the quote, and each defect becomes a one-round copy job.
      const shown = (text: string) => text.length > 160 ? text.slice(0, 160) + '…' : text;
      const elsewhere = groundable.filter(entry => includesQuote(entry.value, String(row.quote)) && entry.path !== path).map(entry => entry.path);
      invalid(label + '引文不在候选声画原文中：' + path
        + (typeof actual === 'string' ? '；该处实际原文是 ' + JSON.stringify(shown(actual)) : '；该 path 在候选中没有可引用的字符串原文')
        + '，报告引用了 ' + JSON.stringify(shown(String(row.quote)))
        + (elsewhere.length
          ? '；同一引文实际出现在 ' + elsewhere.slice(0, 3).join('、') + (elsewhere.length > 3 ? ` 等 ${elsewhere.length} 处` : '') + '，请把 path 改成你真正引用的那一条完整索引路径，quote 保持原样'
          : '；候选中没有任何可引用的声画原文包含这段文字。差异出在用词上就是审稿失真：请就地逐字复制该场 requiredBeats.N.observable.visual[i] 或 audio[i] 的原文，不得增字、减字、换词或补写同义词，也不要为此改动候选本身'));
    }
    const beatMatch = local.match(/^(requiredBeats|beatDramaturgy)\.(\d+)\./);
    if (row.beatId !== undefined) {
      if (timingBeat) {
        if (row.beatId !== timingBeat.sourceBeatId) invalid(label + 'beatId须对应原sourceBeatId：' + JSON.stringify(timingBeat.sourceBeatId) + '，报告写了 ' + JSON.stringify(row.beatId));
      } else if (beatMatch) {
        const beat = rows(item[beatMatch[1]])[Number(beatMatch[2])];
        if ((beat?.id ?? beat?.beatId) !== row.beatId) invalid(label + 'beatId与路径不一致：路径指向 ' + JSON.stringify(beat?.id ?? beat?.beatId) + '，报告写了 ' + JSON.stringify(row.beatId));
      } else if (![...rows(item.requiredBeats), ...rows(item.beatDramaturgy)].some(beat => (beat.id ?? beat.beatId) === row.beatId)) invalid(label + 'beatId不属于候选：' + JSON.stringify(row.beatId));
    }
  };
  evidence.forEach((row, index) => unit(() => {
    const label = 'evidence[' + index + '] ';
    ground(row, label);
    if (typeof row.finding !== 'string' || !row.finding.trim()) invalid(label + '缺少证据说明 finding');
  }));
  const cited = new Set(evidence.map(row => row.itemId));
  // A shooting segment is answered either by its own grounded citation or by an explicit
  // statement naming which cited segment of the same complete scene carries its obligation.
  // Silence stays a defect; the added exit is honest bookkeeping, not a lowered standard.
  const groupId = (item: Record<string, unknown>) => typeof item.dramaticSceneId === 'string' ? item.dramaticSceneId : '';
  const episode = obj(candidate.episodeDrama);
  const promiseBeats = new Set([obj(episode.openingPromise), obj(episode.payoff)]
    .flatMap(check => Array.isArray(check.beatIds) ? check.beatIds : []).map(String));
  const mustCite = new Set([items[0], items[items.length - 1]].filter(item => typeof item?.id === 'string').map(item => String(item.id)));
  for (const item of items) if (rows(item.requiredBeats).some(beat => promiseBeats.has(String(beat.id ?? '')))) mustCite.add(String(item.id));
  const declarations = rows(review.uncovered);
  const declared = new Set<string>();
  if (declarations.length && items.length < 2) problems.push('单场候选必须给出声画证据，uncovered 免证只适用于多场大纲');
  declarations.forEach((row, index) => unit(() => {
    const label = 'uncovered[' + index + '] ';
    const itemId = typeof row.itemId === 'string' ? row.itemId.trim() : '';
    const position = items.findIndex(item => String(item.id) === itemId);
    if (position < 0) invalid(label + 'itemId 必须是当前候选中的场景/镜头 id（当前 ' + JSON.stringify(row.itemId) + '，候选为 ' + JSON.stringify(items.map(item => item.id)) + '）');
    if (declared.has(itemId)) invalid(label + '同一场次不得重复声明免证：' + itemId);
    if (cited.has(itemId)) invalid(label + itemId + ' 已有声画 evidence 落点，不能再声明免证：结论与免证清单矛盾');
    if (typeof row.reason !== 'string' || !row.reason.trim()) invalid(label + 'reason 必须是非空字符串，写出本场为何不需要独立声画落点');
    if (mustCite.has(itemId)) invalid(label + itemId + ' 是候选首场/末场或 episodeDrama 开场承诺、结尾回应节拍所属场次，必须给出声画证据，不得免证');
    const carrierId = typeof row.coveredBy === 'string' ? row.coveredBy.trim() : '';
    const carrier = items.findIndex(item => String(item.id) === carrierId);
    if (carrierId === itemId) invalid(label + 'coveredBy 不能指向本场自身：' + itemId);
    if (carrier < 0) invalid(label + 'coveredBy 必须是当前候选中的另一个场景/镜头 id（当前 ' + JSON.stringify(row.coveredBy) + '）');
    if (!cited.has(items[carrier].id)) invalid(label + 'coveredBy=' + JSON.stringify(row.coveredBy) + ' 没有被本报告 evidence 引用，未证实的场次不能承担本场声画义务');
    const group = groupId(items[position]);
    if (!group || group !== groupId(items[carrier])) invalid(label + '免证声明必须落在同一完整戏内：' + itemId + ' 属于 ' + JSON.stringify(group || undefined) + '，coveredBy 属于 ' + JSON.stringify(groupId(items[carrier]) || undefined));
    declared.add(itemId);
  }));
  for (const item of items) if (!cited.has(item.id) && !declared.has(String(item.id))) problems.push(String(item.id) + '缺少声画覆盖：evidence 中没有指向该场/镜的引文，也没有在 uncovered 用 {itemId,reason,coveredBy} 声明由同一完整戏内哪一场已落点短段承担');
  if (items.length > 1) for (const group of new Set(items.map(groupId).filter(Boolean)))
    if (!items.some(item => groupId(item) === group && cited.has(item.id))) problems.push(group + ' 整场戏没有任何声画 evidence 落点，同一场完整戏不得全部免证');
  const scopes = ['scene', 'dramaticScene', 'episode'];
  const allowed = ['missing_orientation', 'repeated_information', 'missing_response', 'lost_approved_beat', 'indistinct_character_action', 'missing_payoff', 'missing_causal_change'];
  issues.forEach((issue, index) => unit(() => {
    const label = 'issues[' + index + '] ';
    if (!allowed.includes(String(issue.code))) invalid(label + '风格偏好或未支持的问题码不得触发候选重写，移入warnings：' + JSON.stringify(issue.code) + '（可用码：' + allowed.join('、') + '）');
    ground(issue, label);
    if (!scopes.includes(String(issue.scope)) || typeof issue.problem !== 'string' || !issue.problem.trim() || typeof issue.repair !== 'string' || !issue.repair.trim()) invalid(label + '问题缺少具体修复或范围：scope 必须是 scene/dramaticScene/episode，problem 与 repair 必须是非空字符串');
    if (issue.scope === 'episode' && !Array.isArray(candidate.scenes)) invalid(label + '分镜审核不得触发整集重构');
  }));
  const indexHint = '合法索引是 0..' + (evidence.length - 1) + ' 的零基整数（不是 1 基），同一条 evidence 允许被多个分项同时复用，证据条数少于分项数是正常情况，不需要为每个分项另造新证据';
  for (const key of ['orientation', 'dramaticProgression', 'characterDistinction', 'payoff']) unit(() => {
    const check = { ...obj(review[key]) };
    const status = String(check.status);
    if (!['passed', 'failed', 'not_applicable'].includes(status)) invalid(key + '.status 必须是 passed/failed/not_applicable 之一，当前是 ' + JSON.stringify(check.status));
    if (typeof check.reason !== 'string' || !check.reason.trim()) invalid(key + '.reason 必须是非空字符串，写出具体理由');
    if (status === 'not_applicable') {
      if (check.evidenceRefs !== undefined && !Array.isArray(check.evidenceRefs)) invalid(key + ' 判 not_applicable 时 evidenceRefs 只能整个省略或写 []，当前是 ' + JSON.stringify(check.evidenceRefs));
      check.evidenceRefs = [];
    } else if (!Array.isArray(check.evidenceRefs) || !check.evidenceRefs.length) {
      invalid(key + '缺少声画证据索引：判 ' + status + ' 时 evidenceRefs 必须是非空数组。' + indexHint + '。若本候选根本没有分配该义务，如实改判 not_applicable 并在 reason 说明，这不是编造通过');
    } else {
      const bad = check.evidenceRefs.filter(i => !Number.isInteger(i) || !evidence[Number(i)]);
      if (bad.length) invalid(key + '缺少声画证据索引：' + JSON.stringify(bad) + ' 不是有效证据索引。' + indexHint);
      check.evidenceRefs = [...check.evidenceRefs];
    }
    if (status === 'failed' && !issues.length) invalid(key + ' 判 failed 却没有具体问题：失败项目没有具体问题，请在 issues 中给出带证据的条目');
    if (review.passed && status === 'failed') invalid(key + ' 判 failed 与 passed=true 矛盾：结论与分项矛盾');
    review[key] = check;
  });
  if (review.passed !== (issues.length === 0)) problems.push('结论与问题列表矛盾：passed=' + JSON.stringify(review.passed) + '，但 issues 有 ' + issues.length + ' 条');
  const scope = scopes[Math.max(0, ...issues.map(issue => scopes.indexOf(String(issue.scope))))];
  // repairScope is a pure function of issues[] and both the return below and the gate read this
  // derived value, so an echoed mismatch is bookkeeping rather than a wrong judgement. Bouncing
  // the whole report for it burned one paid reviewer call per defect cluster, and a two-defect
  // report never converged inside the recovery budget. The genuine contradiction checks above stay.
  if (problems.length) throw Error('REVIEW_RESULT_INVALID: 叙事报告 '
    + (problems.length > 1 ? '共 ' + problems.length + ' 项独立缺陷，必须在同一份报告里一次性全部修复，不要只修第一项：' : '')
    + problems.slice(0, 20).map((problem, index) => problems.length > 1 ? '(' + (index + 1) + ') ' + problem : problem).join('；')
    + (problems.length > 20 ? '；…另有 ' + (problems.length - 20) + ' 项同类缺陷' : ''));
  return { ...review, passed: review.passed, evidence, issues, repairScope: scope };
}

/** Refresh only the embedded report validator, preserving all editable gate logic. */
export function refreshEmbeddedDramaturgyReviewCode(code: string) {
  // This authored statement lives inside persisted source strings and remains
  // stable when the surrounding application bundle renames function declarations.
  const marker = 'const dramaturgy = cinematic ? (';
  const managed = code.indexOf(marker);
  const start = managed < 0 ? code.indexOf('(function validateDramaturgyReview') : managed + marker.length - 1;
  const end = start < 0 ? -1 : code.indexOf(')(candidate, review.dramaturgyReview)', start);
  return start < 0 || end < 0 ? code : code.slice(0, start) + '(' + validateDramaturgyReview.toString() + code.slice(end);
}

export const DRAMATURGY_ACCEPT_CODE = `
const cinematic = candidate.contentContractVersion === 'cinematic-v1';
const dramaturgy = cinematic ? (${validateDramaturgyReview.toString()})(candidate, review.dramaturgyReview) : {version:'legacy',status:'not-reviewed',passed:true,issues:[],repairScope:'scene'};
const dramaIssues=dramaturgy.issues.map(issue=>({...issue,category:'dramaturgy'}));
const finalIssues=[...combinedIssues,...dramaIssues];
const finalPassed=accepted&&dramaturgy.passed;
const scope=dramaIssues.length?dramaturgy.repairScope:'scene';
const previousRepair=candidate.repairProvenance && typeof candidate.repairProvenance==='object'?candidate.repairProvenance:{};
const priorEpisodeRewrites=Number(previousRepair.episodeRewriteCount||0);
if(scope==='episode' && priorEpisodeRewrites>=1) throw Error('DRAMA_REPAIR_LIMIT: 整集重构已使用一次；保留当前候选，停止自动回写');
if(scope==='episode' && (context.video_take?.url || context.video_shot?.url || context.video_shot?.items?.length)) throw Error('DRAMA_REPAIR_AFTER_MEDIA: 已有媒体，整集问题仅形成剪辑或局部补拍建议');
return {...candidate,passed:finalPassed,issues:finalIssues,contentReview:{...review,passed:accepted,issues:combinedIssues},factualReview:{...review,dramaturgyReview:undefined,passed:accepted,issues:combinedIssues},dramaturgyReview:dramaturgy,
 reviewVersion:'cinematic-review-v1',repairContext:{issues:finalIssues,scope,repairScope:scope,previousCandidate:candidate,historicalLocks:candidate.historicalLocks||previousRepair.historicalLocks||[],episodeRewriteCount:priorEpisodeRewrites+(scope==='episode'?1:0),candidateVersion:Number(previousRepair.candidateVersion||0)+1,parentCandidateVersion:Number(previousRepair.candidateVersion||0)}};
`;

/** Builds a timeline of measured frames/ASR; planned transcript is deliberately excluded. */
export const EPISODE_EVIDENCE_CODE = String.raw`
const list=value=>Array.isArray(value)?value:Array.isArray(value?.items)?value.items:[];
const clips=list(context.episode_timeline?.clips),videos=list(context.video_shot),shots=list(context.shot_script);
const expected=Number(context.scene_outline?.count||context.scene_outline?.scenes?.length||shots.length||clips.length);
const missing=[],segments=[],reviewImages=[];let second=0;
for(let index=0;index<clips.length;index++){
 const clip=clips[index],shot=shots.find(s=>s.id===clip.shotId)||shots[index];
 const video=videos.find(v=>v.url===clip.videoUrl);
 const good=!!video?.decoded&&!!video?.evidenceUrl&&video?.hasAudio===true&&Array.isArray(video.frames)&&video.frames.length>0&&Array.isArray(video.frameTimes)&&video.frames.length===video.frameTimes.length&&Number.isFinite(video.duration)&&video.duration>0;
 if(!good){missing.push({index,shotId:clip.shotId,reason:'缺少与时间线实际视频对应的解码、音轨或采样证据'});second=Number.isFinite(video?.duration)&&video.duration>0&&second!==null?second+video.duration:null;continue;}
 const ambient=shot?.audioType==='环境声' && shot?.audioText==='';
 const transcript=Array.isArray(video.transcript)?video.transcript.filter(r=>typeof r.text==='string'&&Number.isFinite(r.start)&&Number.isFinite(r.end)&&r.end>r.start).map(r=>({start:r.start,end:r.end,text:r.text})):[];
 if(!ambient&&!transcript.length)missing.push({index,shotId:clip.shotId,reason:'缺少实际ASR，计划台词不能代替'});
 const selected=[...new Set([0,Math.floor((video.frames.length-1)/2),video.frames.length-1])];
 const frames=selected.map(frameIndex=>({index:frameIndex,second:video.frameTimes[frameIndex],episodeSecond:second===null?null:second+video.frameTimes[frameIndex],url:video.frames[frameIndex]}));
 reviewImages.push(...frames.map(f=>f.url));
 segments.push({index,shotId:clip.shotId,startSecond:second,duration:video.duration,videoUrl:video.url,evidenceUrl:video.evidenceUrl,frames,transcript,audioMode:ambient?'ambient':'speech',hasAudio:video.hasAudio});second=second===null?null:second+video.duration;
}
if(!expected||clips.length!==expected)missing.push({reason:'实际时间线片段数与批准场景数不一致',expected,actual:clips.length});
const complete=expected>0&&segments.length===expected&&!missing.length;
return {version:'episode-evidence-v1',status:complete?'ready':segments.length?'incomplete':'not-generated',shouldReview:segments.length>0,complete,expectedClips:expected,actualClips:segments.length,segments,reviewImages,missing,totalDuration:second,
 contract:context.scene_outline?.episodeDrama||null,scope:'ordered-sampled-frames-and-actual-asr',fullVideoWatched:false,plannedTranscriptUsed:false};
`;

export const EPISODE_REVIEW_PROMPT = `沿时间线顺序审看附件实际帧和实际ASR，评估观众能否认清处境、看见人物应对/关系变化、是否重复信息、开场问题是否回应。素材清单：\${episode_review_evidence}。
contract只是期望，不能证明实际成片传达。附件按segments、frames排序；仅有抽帧与ASR，没有连续观看或逐帧口型证据。必须声明scope=ordered-sampled-frames-and-actual-asr及fullVideoWatched=false。缺片或缺采证 complete=false 时只评已见部分，不得表示整集通过。若微表情/情绪变化看不清则uncertain，不能推断没发生。
返回 {version:"episode-review-v1",decision:"accepted|needs-edit|uncertain|incomplete",summary:"基于实际声画的结论",fullVideoWatched:false,scope:"ordered-sampled-frames-and-actual-asr",evidence:[{segmentIndex:0,source:"frame|asr",reference:0,quote:"ASR逐字引文（frame可不填）",finding:"实际看到或听到什么"}],issues:[{problem:"具体叙事问题",evidenceRefs:[0],suggestion:"先利用现有片段剪辑/重排/声音衔接；确缺镜头再提局部补拍"}],warnings:[]}。
reference为该segment的frames.index或transcript零基索引。evidence至少覆盖每个实际segment；每条问题须有证据索引。无论审美或全局叙事问题均不允许自动重拍整集；输出供用户审看和编辑的建议。`;

export const EPISODE_REVIEW_ACCEPT_CODE = String.raw`
const e=context.episode_review_evidence,review=context.episode_dramaturgy_review;
const invalid=reason=>{throw Error('REVIEW_RESULT_INVALID: 整集审看报告 '+reason);};
if(!e?.shouldReview)return {version:'episode-review-v1',status:e?.status||'not-generated',label:e?.status==='not-generated'?'成片未生成，实际声画未审看':'成片未完整审看',complete:false,fullVideoWatched:false,automaticReshoot:false,scope:'ordered-sampled-frames-and-actual-asr',missing:e?.missing||[]};
if(!review||review.version!=='episode-review-v1'||!['accepted','needs-edit','uncertain','incomplete'].includes(review.decision)||!review.summary?.trim()||!Array.isArray(review.evidence)||!review.evidence.length||!Array.isArray(review.issues)||!Array.isArray(review.warnings)||review.fullVideoWatched!==false||review.scope!==e.scope)invalid('结构或审看范围不实');
for(const row of review.evidence){const segment=e.segments.find(s=>s.index===row.segmentIndex);if(!segment||!row.finding?.trim())invalid('缺少实际片段定位');
 if(row.source==='frame'){if(!segment.frames.some(f=>f.index===row.reference))invalid('引用未采样帧');}
 else if(row.source==='asr'){const actual=segment.transcript[row.reference];if(!actual||!row.quote?.trim()||!actual.text.includes(row.quote))invalid('引用不存在的实际ASR');}
 else invalid('不允许以计划或目的证明实际声画');
}
for(const segment of e.segments)if(!review.evidence.some(row=>row.segmentIndex===segment.index))invalid('未按顺序覆盖实际片段');
for(const issue of review.issues)if(!issue.problem?.trim()||!issue.suggestion?.trim()||!Array.isArray(issue.evidenceRefs)||!issue.evidenceRefs.length||issue.evidenceRefs.some(i=>!Number.isInteger(i)||!review.evidence[i]))invalid('问题缺少采证定位或剪辑建议');
if(!e.complete && review.decision!=='incomplete')invalid('部分素材不能声明整集已完整审看');
if(review.decision==='accepted'&&review.issues.length)invalid('通过与问题列表矛盾');
if(review.decision==='needs-edit'&&!review.issues.length)invalid('编辑问题为空');
return {...review,status:!e.complete?'incomplete':review.decision,complete:e.complete,label:!e.complete?'成片未完整审看':review.decision==='accepted'?'整集抽帧与实际台词审看通过':'整集抽帧与实际台词审看待处理',automaticReshoot:false,fullVideoWatched:false,missing:e.missing,evidenceVersion:e.version,actualClips:e.actualClips,expectedClips:e.expectedClips};
`;
