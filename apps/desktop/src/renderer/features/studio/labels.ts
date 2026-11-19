import { useTranslation } from 'react-i18next';

const labels = {
  studio: ['Animation studio', '动画工作台'], quick: ['Quick template', '快速模板'], newQuick: ['New quick project…', '新建快速工程…'], code: ['Template code', '模板代码'],
  newAnimation: ['New animation…', '新建动画…'], fromQuick: ['Use current template…', '用当前模板新建…'],
  intro: ['Start an animation to edit multiple tracks.', '新建动画即可编辑多条轨道。'],
  tracks: ['Tracks', '轨道'], track: ['Track', '轨道'], trackName: ['Track name', '轨道名称'], addTrack: ['Add track', '添加轨道'],
  mute: ['Mute track', '静音轨道'], lock: ['Lock track', '锁定轨道'], deleteTrack: ['Delete empty track', '删除空轨道'],
  frame: ['Frame', '帧'], length: ['Length (frames)', '长度（帧）'], duration: ['Total frames', '总帧数'], first: ['First frame', '首帧'], last: ['Last frame', '末帧'],
  add: ['Add…', '添加…'], addTemplate: ['Template…', '模板…'], selectTemplate: ['Choose a template', '选择模板'],
  noTemplates: ['No templates installed.', '没有已安装的模板。'], missingTemplate: ['Install this exact template version to edit its parameters.', '请安装此版本的模板以编辑参数。'],
  start: ['Start frame', '起始帧'], sourceIn: ['Source in (frames)', '源入点（帧）'], trimIn: ['Trim in at playhead', '在播放头修剪入点'], trimOut: ['Trim out at playhead', '在播放头修剪出点'],
  split: ['Split', '分割'], duplicate: ['Duplicate', '复制'], delete: ['Delete clip', '删除片段'], moveTo: ['Move to track', '移到轨道'],
  empty: ['Add a clip at the playhead.', '在播放头位置添加片段。'],
  clip: ['Clip', '片段'], template: ['Template', '模板'], content: ['Content', '内容'], timing: ['Timing', '时间'],
  clipActions: ['Clip actions', '片段操作'], timelineActions: ['Timeline actions', '时间轴操作'],
  openClipSettings: ['Clip settings…', '片段设置…'], clipSettings: ['Clip settings', '片段设置'],
  changeObjectKind: ['Change object type', '更换对象类型'], resourceVersion: ['Resource version', '资源版本'],
  renameTrack: ['Rename track…', '重命名轨道…'], rename: ['Rename', '重命名'],
  lockNote: ['Unlock the track to edit this clip.', '解锁轨道后可编辑此片段。'],
  transform: ['Transform', '变换'], x: ['X', '横向'], y: ['Y', '纵向'], scale: ['Scale', '缩放'], rotation: ['Rotation (°)', '旋转（°）'], opacity: ['Opacity', '不透明度'],
  base: ['Base values', '基准值'], keyframe: ['Keyframe values', '关键帧值'], addKey: ['Add keyframe', '添加关键帧'], removeKey: ['Remove keyframe', '删除关键帧'],
  sound: ['Audio', '音频'], image: ['Image', '图像'], text: ['Text', '文字'], block: ['Blocks', '方块'], player: ['Player', '玩家'],
  missingImage: ['An image needs relinking. Choose the picture again to authorize it.', '有图片需要重链。请重新选择图片进行授权。'],
  resolution: ['Output size (pixels)', '输出尺寸（像素）'], width: ['Width', '宽度'], height: ['Height', '高度'],
  profile: ['Resource profile', '资源档案'], inherit: ['Follow project', '跟随工程'], activeProfile: ['Use active resources', '使用当前资源'], missingProfile: ['Missing profile', '资源档案缺失'],
  compositionSettings: ['Animation settings', '动画设置'],
  limit: ['No more room at this frame. Move the playhead or add a track.', '此帧无法再添加片段。请移动播放头或添加轨道。'],
} as const;

export function useStudioLabels() {
  const { i18n } = useTranslation();
  return (key: keyof typeof labels) => labels[key][i18n.language.startsWith('zh') ? 1 : 0];
}
