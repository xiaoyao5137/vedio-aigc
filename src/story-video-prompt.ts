/** The reviewed action string also carries the checked in-frame vocal beats. */
export const STORY_SHOT_VIDEO_INSTRUCTION = '【剧情与声音】按已校验的剧情段落完成动作，并让对应角色在所属段落自然发声：${shot.timedActions}。角色声音须清楚可听，与画面里的动作和对方反应相配；环境声不得盖过叫声。不要给叫声安排精确秒点。在 ${shot.duration} 秒内先完成全部必需动作，再保留至少 1 秒可读终态；不要让交接、反应或收尾停在最后一帧。'

export const STORY_SHOT_IMAGE_PROMPT = '生成一张9:16竖屏写实摄影照片，作为芙伊与卷毛同居生活短剧的静止首帧。只呈现一个时间点、一个机位、一次曝光的完整连续场景。画面内容：${shot.firstFramePrompt}。严格保留上传参考图中猫芙伊和狗卷毛各自的物种、脸型、毛色、毛发质感和爪形，不变成人脸或裸露的人类手指脚趾。芙伊为努力工作、赚钱养家的猫；卷毛为不上班、在家躺平或出门游玩的舍友，穿休闲服，不给卷毛工牌、员工制服、收银台岗位或会议工作身份。服饰、姿态、地点和道具以本镜剧本为准；若芙伊在办公室或家中工作，保留相应工作状态，不把卷毛也改成同事。首帧只呈现本镜动作开始前的状态，不提前展示后续结果。每个真实出镜角色在同一物理场景只出现一次，主体的脸、前爪及关键道具完整可见；若卷毛只在设备通话画面中，保留设备内的远端形象，不在芙伊所在地另造一只实体狗，也不强求舍友处于同一物理空间。保持真实摄影的毛发、材质、光线和空间关系。不要呈现动作过程或多个瞬间；不要把整幅画面做成分屏、上下三格、连环画、重复角色、拼贴、边框、分隔线或画中画；不要可读文字、字幕或水印。剧本需要的真实电脑或手机屏幕可显示无文字界面，但须符合设备结构与使用方向，不在电脑背壳贴界面，不生成无支撑的额外屏幕。'

export const STORY_SHOT_VIDEO_PROMPT = '以输入首帧为开场，生成一段连续的9:16竖屏写实短视频。严格延续猫芙伊与狗卷毛的脸型、毛色、毛发质感、爪形、服饰、姿态、角色数量及本镜地点，不变成人脸或裸露的人类手指脚趾。芙伊努力工作、赚钱养家；卷毛是与她同居、不上班、常在家躺平或出门游玩的舍友，不把卷毛演成店员、收银员、办公室同事或会议参与者。用有毛爪形的前肢完成剧本动作，保持连续的空间、道具归属、动作因果与对方的可见反应。若卷毛只在芙伊的设备通话画面中，其“旺”须从设备传出、与设备画面中的动作相配；不得在芙伊办公室凭空增加实体狗。镜头运动：${shot.camera}。氛围：${shot.mood}。全片持续保留与场景相符的自然环境声和动作音效，不要把非叫声时段处理为静音。角色发声只允许动物原声：猫芙伊只发自然猫叫“喵”，狗卷毛只发自然狗吠“汪”；剧本中的“喵儿”“旺”只是叫声标记，绝不能由人声朗读、模仿或配音，也不要出现人类说话、唱歌、旁白或背景人声。根据各段剧情安排对应角色的声音，让来回回应清楚可听并与可见互动相配；环境声和动作音效不能盖过叫声。不要添加字幕、文字、气泡、水印、分屏或跳切。\n' + STORY_SHOT_VIDEO_INSTRUCTION

/** Existing saved workflows may still carry the old, explicitly silent
 * employee-only default. Replace only that known default; custom prompts keep
 * their wording and receive the checked action/vocal plan below. */
export function upgradeStoryShotVideoPrompt(prompt: string): string {
  if (prompt.startsWith('以输入首帧为开场，生成一段连续的9:16竖屏写实职场短视频。角色是具有猫狗外形的职场员工')
    && prompt.includes('无人话、旁白、配音或台词')) return STORY_SHOT_VIDEO_PROMPT
  if (prompt.startsWith('以输入首帧为开场，生成一段连续的9:16竖屏写实短视频。严格延续猫芙伊与狗卷毛')
    && prompt.includes('每声按下列秒段与可见嘴部动作同步')) return STORY_SHOT_VIDEO_PROMPT
  const timed = prompt.replaceAll('${shot.content}', '${shot.timedActions}')
    .replaceAll('${shotTimedActions}', '${shot.timedActions}')
  // A heading or descriptive phrase is not a binding to the compiled plan.
  return timed.includes('${shot.timedActions}') ? timed : `${timed.trim()}\n${STORY_SHOT_VIDEO_INSTRUCTION}`
}

export function upgradeStoryShotImagePrompt(prompt: string): string {
  return prompt.startsWith('生成一张9:16竖屏写实摄影照片，作为拟人化职场短剧开场的静止首帧。')
    && prompt.includes('职业服饰、工牌、直立或员工坐姿、办公空间与道具')
    ? STORY_SHOT_IMAGE_PROMPT : prompt
}
