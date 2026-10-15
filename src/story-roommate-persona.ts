/** The two leads have fixed story identities across every wf-story execution. */
export const STORY_ROOMMATE_PERSONA_CONTRACT = 'roommate-cat-dog-v1'

type JsonObject = Record<string, unknown>

function object(value: unknown): JsonObject | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : undefined
}

const DOG = '(?:卷毛|黄白柴犬|柴犬|狗)'
const CAT = '(?:芙伊|矮脚蓝猫|蓝猫|猫)'
const dogIdentity = new RegExp(`${DOG}[^。；;\n]{0,24}(?:是|当|担任|作为|成为|扮演)[^。；;\n]{0,18}(?:同事|员工|店员|收银员|咖啡师|服务员|职员|实习生|老板|经理|打工人)`, 'u')
const pairedWorkers = new RegExp(`(?:${CAT}(?:和|与|跟)${DOG}|${DOG}(?:和|与|跟)${CAT}|两人|他们)[^。；;\n]{0,18}(?:同事|同一家公司|一起上班|共同工作|共同汇报|共同参会|一起开会|一起评审)`, 'u')
const catSupportedByDog = new RegExp(`${CAT}(?:(?:是|也|一直|长期|目前|现在|已经|变得|处于|仍然|没|没有)[^。；;\n]{0,4}(?:无业|失业|不工作|不上班)|[^。；;\n]{0,18}(?:靠${DOG}养|由${DOG}养))`, 'u')

const dogEmployeeAppearance = new RegExp(`${DOG}[^。；;\n]{0,26}(?:戴|佩戴|挂着|穿着|同款|以)[^。；;\n]{0,12}(?:工牌|工作证|员工制服|店员制服|员工姿态)`, 'u')
const dogBehindCounterOrAtDesk = new RegExp(`${DOG}[^。；;\n]{0,26}(?:在|站在|坐在|躺在|位于|进入|绕到|守着|靠在)[^。；;\n]{0,12}(?:收银位|收银台后|柜台后|员工位|办公工位|工作席|办公椅后|会议席)(?!前)`, 'u')
const dogOfficeWork = new RegExp(`${DOG}[^。；;\n]{0,26}(?:打卡上班|到公司上班|在(?:咖啡店|早餐店|公司|办公室)工作|加班|值班|接单|为顾客收银|负责收银|在收银台收款|操作收银机|给顾客做咖啡|主持会议|参加会议|参与工作评审|参与方案评审|远程工作评审|提交工作方案|向老板汇报|领取工资)`, 'u')
const apron = '(?:系着?|穿着?|围着)(?:一条)?围裙'
const shopCounter = '(?:站在|守在|坐在)(?:咖啡店|早餐店)(?:的)?(?:吧台|柜台|取餐台|收银台)(?!前)'
const dogApronAtShopCounter = new RegExp(`${DOG}[^。；;\n]{0,30}(?:${apron}[^。；;\n]{0,26}${shopCounter}|${shopCounter}[^。；;\n]{0,26}${apron})`, 'u')
const dogServingCustomers = new RegExp(`${DOG}[^。；;\n]{0,42}(?:接(?:过|下)?(?:客人|顾客)(?:的)?(?:订单|点单|餐单)|(?:给|为)(?:顾客|客人)(?:端(?:上|出)?|递(?:出|上)?|送(?:上|出)?|做|调制|冲泡)(?:一杯|两杯|一份|两份)?(?:咖啡|拿铁|早餐|餐品|餐点)|(?:端(?:上|出)?|递(?:出|上)?|送(?:上|出)?)(?:一杯|两杯|一份|两份)?(?:咖啡|拿铁|早餐|餐品|餐点)(?:给|向)(?:顾客|客人)|(?:向|从|给|为)(?:顾客|客人)(?:收钱|收款|收费|结账|找零))`, 'u')

const rules = [
  { label: '卷毛被写成有职业或芙伊的同事', pattern: dogIdentity, negatable: true },
  { label: '两位舍友被写成同事或共同上班', pattern: pairedWorkers, negatable: true },
  { label: '芙伊的工作养家身份被反转', pattern: catSupportedByDog },
  { label: '卷毛穿戴了员工身份标记', pattern: dogEmployeeAppearance, negatable: true },
  { label: '卷毛占据店员或办公岗位', pattern: dogBehindCounterOrAtDesk },
  { label: '卷毛执行了工作任务', pattern: dogOfficeWork },
  { label: '卷毛穿围裙占据咖啡或早餐店吧台岗位', pattern: dogApronAtShopCounter },
  { label: '卷毛向顾客提供店员服务', pattern: dogServingCustomers },
]

/** Reject explicit identity contradictions before any paid image/video request.
 * This is deliberately limited to concrete written claims. Absence of a
 * contradiction does not certify the artistic quality of a story. */
export function storyRoommatePersonaIssues(output: unknown): string[] {
  const shots = Array.isArray(output) ? output : object(output)?.shots
  if (!Array.isArray(shots)) return []
  const issues: string[] = []
  shots.forEach((candidate, shotIndex) => {
    const shot = object(candidate)
    if (!shot) return
    const fields: Array<[string, unknown]> = [
      ['title', shot.title], ['content', shot.content], ['mood', shot.mood],
      ['firstFramePrompt', shot.firstFramePrompt],
    ]
    if (Array.isArray(shot.visualBeats)) shot.visualBeats.forEach((candidateBeat, beatIndex) => {
      const beat = object(candidateBeat)
      if (beat) fields.push([`visualBeats[${beatIndex}].action`, beat.action],
        [`visualBeats[${beatIndex}].completion`, beat.completion])
    })
    for (const [path, value] of fields) {
      if (typeof value !== 'string') continue
      for (const rule of rules) {
        const match = value.match(rule.pattern)
        if (!match) continue
        // A negative role statement is compatible with the contract.
        const claim = match[0]
        if (rule.negatable && /(?:不是|并非|绝非|没有|不当|不戴|不穿|不能|不得)[^。；;\n]{0,12}(?:同事|员工|店员|收银员|咖啡师|服务员|职员|实习生|老板|经理|打工人|工牌|工作证|员工制服|店员制服)/u.test(claim)) continue
        issues.push(`shots[${shotIndex}].${path} ${rule.label}：“${claim}”`)
      }
    }
  })
  return issues
}
