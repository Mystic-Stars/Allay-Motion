import { z } from 'zod';

const LanguageSchema = z.record(z.string(), z.string());
export type SoundLanguage = Readonly<Record<string, string>>;

export function parseSoundLanguage(text: string): SoundLanguage {
  try {
    return LanguageSchema.parse(JSON.parse(text.replace(/^\uFEFF/, '')));
  } catch {
    return {};
  }
}

export interface SoundNames {
  'zh-CN'?: string;
  en?: string;
  chinese: 'subtitle' | 'terminology' | 'missing' | 'custom';
}

// 中文 Wiki 的实体、方块及群系术语；这是应用的术语表，不是游戏语言文件。
const TERMS: Readonly<Record<string, string>> = {
  allay: '悦灵', armadillo: '犰狳', bogged: '沼骸', breeze: '旋风人', creaking: '嘎枝', warden: '监守者',
  sniffer: '嗅探兽', axolotl: '美西螈', enderman: '末影人', endermite: '末影螨', phantom: '幻翼',
  pillager: '掠夺者', vindicator: '卫道士', evoker: '唤魔者', ravager: '劫掠兽', vex: '恼鬼',
  wither: '凋灵', wither_skeleton: '凋灵骷髅', hoglin: '疣猪兽', zoglin: '僵尸疣猪兽', strider: '炽足兽',
  piglin: '猪灵', piglin_brute: '猪灵蛮兵', zombified_piglin: '僵尸猪灵', ghast: '恶魂', happy_ghast: '快乐恶魂',
  shulker: '潜影贝', snow_golem: '雪傀儡', iron_golem: '铁傀儡', silverfish: '蠹虫', blaze: '烈焰人',
  skeleton: '骷髅', stray: '流浪者', zombie: '僵尸', husk: '尸壳', drowned: '溺尸', zombie_villager: '僵尸村民',
  villager: '村民', zombie_horse: '僵尸马', skeleton_horse: '骷髅马', player: '玩家', generic: '',
  experience_orb: '经验球', ender_dragon: '末影龙', dragon_fireball: '龙息弹', firework_rocket: '烟花火箭',
  chicken: '鸡', pig: '猪', sheep: '羊', cow: '牛', wolf: '狼', cat: '猫', parrot: '鹦鹉', rabbit: '兔子',
  horse: '马', mule: '骡', donkey: '驴', fox: '狐狸', goat: '山羊', camel: '骆驼', panda: '熊猫', frog: '青蛙',
  tadpole: '蝌蚪', turtle: '海龟', bee: '蜜蜂', bat: '蝙蝠', dolphin: '海豚', squid: '鱿鱼', glow_squid: '发光鱿鱼',
  salmon: '鲑鱼', cod: '鳕鱼', tropical_fish: '热带鱼', puffer_fish: '河豚', polar_bear: '北极熊',
  spider: '蜘蛛', slime: '史莱姆', magma_cube: '岩浆怪', guardian: '守卫者', elder_guardian: '远古守卫者',
  witch: '女巫', wandering_trader: '流浪商人', creeper: '苦力怕', llama: '羊驼', ocelot: '豹猫',
  stone: '石头', wood: '木头', grass: '草方块', gravel: '沙砾', sand: '沙子', glass: '玻璃', wool: '羊毛',
  copper: '铜块', amethyst_block: '紫水晶块', amethyst_cluster: '紫水晶簇', sculk: '幽匿块', trial_spawner: '试炼刷怪笼',
  bamboo_wood: '竹木', bamboo_wood_hanging_sign: '悬挂式竹木告示牌', cherry_wood: '樱花木', cherry_wood_hanging_sign: '悬挂式樱花木告示牌',
  azalea_leaves: '杜鹃树叶', cave_vines: '洞穴藤蔓', coral_block: '珊瑚块', froglight: '蛙明灯', hanging_sign: '悬挂式告示牌',
  metal: '金属方块', moss: '苔藓块', nether_ore: '下界矿石', nether_wood: '下界木材', nether_wood_hanging_sign: '悬挂式下界木告示牌',
  nylium: '菌岩', roots: '菌索', stem: '菌柄', wart_block: '疣块', wet_grass: '水草',
  vault: '宝库', nether: '下界', the_end: '末地', overworld: '主世界', basalt_deltas: '玄武岩三角洲',
  crimson_forest: '绯红森林', warped_forest: '诡异森林', soul_sand_valley: '灵魂沙峡谷', nether_wastes: '下界荒地',
  deep_dark: '深暗之域', lush_caves: '繁茂洞穴', dripstone_caves: '溶洞', cherry_grove: '樱花树林',
  meadow: '草甸', grove: '雪林', snowy_slopes: '积雪山坡', frozen_peaks: '冰封山峰', jagged_peaks: '尖峭山峰',
  stony_peaks: '裸岩山峰', desert: '沙漠', badlands: '恶地', jungle: '丛林', forest: '森林', swamp: '沼泽',
  mangrove_swamp: '红树林沼泽', pale_garden: '苍白之园', ocean: '海洋', river: '河流', underwater: '水下',
  bamboo_jungle: '竹林', flower_forest: '繁花森林', old_growth_taiga: '原始针叶林', sparse_jungle: '稀疏丛林', sulfur_caves: '硫黄洞穴',
};

const ACTIONS: Readonly<Record<string, string>> = {
  ambient: '发出声音', hurt: '受伤', death: '死亡', step: '脚步声', swim: '游泳', splash: '溅水',
  attack: '攻击', celebrate: '庆祝', eat: '进食', drink: '饮用', angry: '发怒', flap: '扇动翅膀',
  place: '放置', break: '破坏', fall: '落地', hit: '被击打', open: '打开', close: '关闭',
  explode: '爆炸', shoot: '发射', teleport: '传送', pickup: '被拾取', levelup: '升级',
};

const EXACT: Readonly<Record<string, string>> = {
  'ambient.cave': '洞穴环境音', 'ambient.underwater.enter': '入水', 'ambient.underwater.exit': '离开水面',
  'ui.button.click': '按钮被点击', 'ui.toast.in': '提示弹出', 'ui.toast.out': '提示消失', 'ui.toast.challenge_complete': '挑战完成',
  'music.game': '游戏背景音乐', 'music.menu': '主菜单音乐', 'music.creative': '创造模式音乐',
  'music.credits': '终末之诗与制作人员名单音乐', 'music.dragon': '末影龙战斗音乐', 'music.end': '末地背景音乐',
  'music.under_water': '水下背景音乐', 'item.goat_horn.play': '山羊角吹响',
  'ambient.underwater.loop.additions': '随机水下环境音', 'ambient.underwater.loop.additions.rare': '罕见水下环境音',
  'ambient.underwater.loop.additions.ultra_rare': '极罕见水下环境音', 'block.conduit.ambient.short': '潮涌核心短促脉动',
  'block.fungus.fall': '落在菌类上', 'block.lodestone.step': '在磁石上行走', 'block.pointed_dripstone.land': '滴水石锥着地',
  'block.potent_sulfur.geyser_continuous_eruption_active': '间歇泉持续喷发',
  'block.potent_sulfur.geyser_eruption_active': '间歇泉喷发',
  'entity.baby_chicken.step': '小鸡的脚步声', 'entity.baby_chicken.hurt': '小鸡受伤', 'entity.bat.loop': '蝙蝠飞行', 'entity.frog.tongue': '青蛙伸出舌头',
  'entity.ghast.scream': '恶魂尖叫', 'entity.minecart.inside': '乘坐矿车', 'entity.minecart.inside.underwater': '在水下乘坐矿车',
  'entity.player.breath': '玩家呼吸', 'entity.strider.saddle': '给炽足兽装上鞍',
  'entity.small_sulfur_cube.squish': '小型硫方怪挤压', 'entity.sulfur_cube.squish': '硫方怪挤压',
  'ui.loom.select_pattern': '选择织布机图案', 'ui.stonecutter.select_recipe': '选择切石机配方',
  'music_disc.creator_music_box': '音乐唱片《Creator》（八音盒版）',
  'music_disc.lava_chicken': '音乐唱片《Lava Chicken》',
  'entity.fish.swim': '鱼游动', 'entity.skeleton_horse.jump_water': '骷髅马在水中跳跃', 'entity.wolf.howl': '狼嚎叫',
  'item.crossbow.loading_middle': '弩正在装填', 'item.elytra.flying': '使用鞘翅滑翔',
};

function terminology(path: string, zh: SoundLanguage): string | undefined {
  if (Object.hasOwn(EXACT, path)) return EXACT[path];
  const parts = path.split('.');
  const { 0: category, 1: subject, 2: action, length } = parts;
  if (category === 'block' && action === 'fall' && length === 3 && subject) {
    const key = `block.minecraft.${subject}`;
    const local = Object.hasOwn(zh, key) ? zh[key] : undefined;
    const block = local && /\p{Script=Han}/u.test(local) ? local : Object.hasOwn(TERMS, subject) ? TERMS[subject] : undefined;
    if (block) return `落在${block}上`;
  }
  if (category === 'music' && length >= 3) {
    const biome = parts.at(-1)!;
    if (Object.hasOwn(TERMS, biome)) return `${TERMS[biome]}背景音乐`;
  }
  if (category === 'ambient' && length === 3 && subject && Object.hasOwn(TERMS, subject)) {
    if (action === 'loop' || action === 'additions' || action === 'mood') {
      return `${TERMS[subject]}${action === 'loop' ? '环境音' : action === 'additions' ? '随机环境音' : '氛围声'}`;
    }
  }
  if (category === 'music_disc' && length === 2 && subject && /^[a-z0-9_]+$/.test(subject)) return `音乐唱片《${subject.replaceAll('_', ' ')}》`;
  if (length === 3 && (category === 'entity' || category === 'block') && subject && action && Object.hasOwn(TERMS, subject) && Object.hasOwn(ACTIONS, action)) {
    return category === 'block' && (action === 'place' || action === 'break') ? `${ACTIONS[action]}${TERMS[subject]}` : `${TERMS[subject]}${ACTIONS[action]}`;
  }
  return undefined;
}

export function soundNames(id: string, vanilla: boolean, subtitle: string | undefined, zh: SoundLanguage, en: SoundLanguage): SoundNames {
  const lookup = (lang: SoundLanguage) => subtitle && Object.hasOwn(lang, subtitle) ? lang[subtitle]?.trim() : undefined;
  const english = lookup(en);
  const chinese = lookup(zh);
  if (chinese && /\p{Script=Han}/u.test(chinese)) return { 'zh-CN': chinese, ...(english ? { en: english } : {}), chinese: 'subtitle' };
  const authored = vanilla && id.startsWith('minecraft:') ? terminology(id.slice('minecraft:'.length), zh) : undefined;
  return { ...(authored ? { 'zh-CN': authored } : {}), ...(english ? { en: english } : {}), chinese: authored ? 'terminology' : vanilla ? 'missing' : 'custom' };
}

export function missingVanillaSoundNames(events: Iterable<{ id: string; names: SoundNames }>): string[] {
  return [...events].filter(({ names }) => names.chinese === 'missing').map(({ id }) => id).sort();
}
