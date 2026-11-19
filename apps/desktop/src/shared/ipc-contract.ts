import { z } from 'zod';
import { AudioWavSchema, DiagnosticsTextSchema, ExportJobIdSchema, ExportStartSchema, FramePixelsSchema } from './export';
import { IPC, type InvokeChannel } from './ipc-channels';
import {
  AddPackKindSchema,
  DroppedPathSchema,
  LayerIdSchema,
  ResourceIdSchema,
  ResourcePathSchema,
  ResourceProfileIdSchema,
  ResourceLocationSchema,
  OfficialVersionIdSchema,
  ResourcePrefixSchema,
  ResourceStampSchema,
  SoundEventIdSchema,
  SoundFileNamesSchema,
  ThumbKeySchema,
  ThumbPngSchema,
  VanillaPatchSchema,
} from './resources';
import { HostCommandResultSchema } from './host-commands';
import { MacMenuStateSchema } from './mac-menu';
import { ProjectDataSchema, ProjectHandleSchema } from './project';
import { UiSettingsPatchSchema } from './settings';
import { FolderKindSchema } from './folders';
import { AuthoringNameSchema, CompositionPackageIdSchema, FreezeCompositionSchema, SourceRefSchema, WriteSourceSchema } from './template-authoring';
import { JavaNameSchema, SkinLocaleSchema, SkinModelSchema, SkinRefSchema } from './skins';
import {
  AssetPathSchema,
  CopyBuiltinSchema,
  InstallReportSchema,
  PresetIdSchema,
  SaveDerivedSchema,
  SavePresetSchema,
  StagingIdSchema,
  TemplateIdArgSchema,
  TemplateVersionArgSchema,
} from './templates';

// 每个 invoke 通道的入参 schema（整个参数列表是一个 tuple，多一个参数也拒绝）。
// 主进程的处理函数只接收经过这里校验的参数。

const HexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/);

export const TitleBarColorsSchema = z.strictObject({
  color: HexColor,
  symbolColor: HexColor,
});
export type TitleBarColors = z.infer<typeof TitleBarColorsSchema>;

/** 文件引用：主进程发给渲染进程的不透明 ID，不是路径 */
export const FileRefSchema = z.uuid();

/** 文件关联的一次性令牌（M8）：主进程签发，换回的是主进程自己记着的路径 */
export const OpenRequestTokenSchema = z.uuid();

/** asset: 引用从哪个模板读：已安装的（id + 版本），或正在试运行的暂存包 */
export const AssetSourceSchema = z.union([
  z.strictObject({ id: TemplateIdArgSchema, version: TemplateVersionArgSchema }),
  z.strictObject({ stagingId: StagingIdSchema }),
]);

export const IPC_ARGS = {
  [IPC.app.info]: z.tuple([]),
  [IPC.settings.get]: z.tuple([]),
  [IPC.settings.set]: z.tuple([UiSettingsPatchSchema]),
  [IPC.window.setTitleBarColors]: z.tuple([TitleBarColorsSchema]),
  [IPC.window.reload]: z.tuple([]),
  [IPC.files.pickImage]: z.tuple([]),
  [IPC.files.read]: z.tuple([FileRefSchema]),
  [IPC.fonts.list]: z.tuple([ResourceProfileIdSchema.optional()]),
  [IPC.sound.pick]: z.tuple([z.enum(['effect', 'music'])]),
  [IPC.sound.list]: z.tuple([]),
  [IPC.sound.read]: z.tuple([SoundEventIdSchema, ResourceProfileIdSchema.optional()]),
  [IPC.sound.fetchNames]: z.tuple([]),
  [IPC.skins.list]: z.tuple([]),
  [IPC.skins.importPng]: z.tuple([SkinModelSchema]),
  [IPC.skins.fetchJava]: z.tuple([JavaNameSchema, SkinLocaleSchema]),
  [IPC.skins.read]: z.tuple([SkinRefSchema]),
  [IPC.skins.remove]: z.tuple([SkinRefSchema]),
  [IPC.export.start]: z.tuple([ExportStartSchema]),
  [IPC.export.writeFrame]: z.tuple([ExportJobIdSchema, FramePixelsSchema]),
  [IPC.export.writeAudio]: z.tuple([ExportJobIdSchema, AudioWavSchema]),
  [IPC.export.finish]: z.tuple([ExportJobIdSchema]),
  [IPC.export.cancel]: z.tuple([ExportJobIdSchema]),
  [IPC.export.ffmpegInfo]: z.tuple([]),
  /** force：忽略缓存重新试编码 */
  [IPC.export.probeEncoders]: z.tuple([z.boolean()]),
  [IPC.export.outputFolder]: z.tuple([]),
  [IPC.export.chooseFolder]: z.tuple([]),
  [IPC.export.reveal]: z.tuple([ExportJobIdSchema]),
  [IPC.export.copyDiagnostics]: z.tuple([DiagnosticsTextSchema]),
  [IPC.resources.layers]: z.tuple([]),
  [IPC.resources.stamp]: z.tuple([]),
  [IPC.resources.read]: z.tuple([ResourcePathSchema, ResourceProfileIdSchema.optional()]),
  [IPC.resources.readTexture]: z.tuple([ResourceIdSchema, ResourceProfileIdSchema.optional()]),
  [IPC.resources.list]: z.tuple([ResourcePrefixSchema, ResourceProfileIdSchema.optional()]),
  [IPC.resources.soundVariants]: z.tuple([SoundEventIdSchema, ResourceProfileIdSchema.optional()]),
  [IPC.resources.soundLibrary]: z.tuple([ResourceProfileIdSchema.optional()]),
  [IPC.resources.soundFiles]: z.tuple([SoundFileNamesSchema, z.boolean(), ResourceProfileIdSchema.optional()]),
  [IPC.resources.fontProviders]: z.tuple([ResourceIdSchema, ResourceProfileIdSchema.optional()]),
  [IPC.resources.detectMinecraft]: z.tuple([]),
  [IPC.resources.setVanilla]: z.tuple([VanillaPatchSchema]),
  [IPC.resources.chooseGameDir]: z.tuple([ResourceProfileIdSchema.optional()]),
  [IPC.resources.selectProfile]: z.tuple([ResourceProfileIdSchema.nullable()]),
  [IPC.resources.officialVersions]: z.tuple([]),
  [IPC.resources.locateProfile]: z.tuple([ResourceProfileIdSchema, ResourceLocationSchema]),
  [IPC.resources.instancePacks]: z.tuple([ResourceProfileIdSchema]),
  [IPC.resources.setInstancePack]: z.tuple([ResourceProfileIdSchema, ResourceProfileIdSchema, z.boolean()]),
  [IPC.resources.downloadVanilla]: z.tuple([OfficialVersionIdSchema.optional()]),
  [IPC.resources.cancelDownload]: z.tuple([]),
  [IPC.resources.addPack]: z.tuple([AddPackKindSchema, ResourceProfileIdSchema.optional()]),
  [IPC.resources.addDroppedPack]: z.tuple([DroppedPathSchema]),
  [IPC.resources.removeLayer]: z.tuple([LayerIdSchema]),
  [IPC.resources.reorder]: z.tuple([z.array(LayerIdSchema).max(256)]),
  [IPC.resources.setEnabled]: z.tuple([LayerIdSchema, z.boolean()]),
  [IPC.templates.list]: z.tuple([]),
  [IPC.templates.read]: z.tuple([TemplateIdArgSchema, TemplateVersionArgSchema]),
  [IPC.templates.readAsset]: z.tuple([AssetSourceSchema, AssetPathSchema]),
  [IPC.templates.install]: z.tuple([]),
  [IPC.templates.installDropped]: z.tuple([DroppedPathSchema]),
  [IPC.templates.installRequested]: z.tuple([OpenRequestTokenSchema]),
  [IPC.templates.commitInstall]: z.tuple([StagingIdSchema, InstallReportSchema]),
  [IPC.templates.cancelInstall]: z.tuple([StagingIdSchema]),
  [IPC.templates.remove]: z.tuple([TemplateIdArgSchema, TemplateVersionArgSchema]),
  [IPC.templates.exportPackage]: z.tuple([TemplateIdArgSchema, TemplateVersionArgSchema]),
  [IPC.templates.saveDerived]: z.tuple([SaveDerivedSchema]),
  [IPC.templates.copyBuiltin]: z.tuple([CopyBuiltinSchema]),
  [IPC.templates.writeDevFiles]: z.tuple([TemplateIdArgSchema, TemplateVersionArgSchema]),
  [IPC.templates.openFolder]: z.tuple([TemplateIdArgSchema, TemplateVersionArgSchema]),
  [IPC.templates.readSource]: z.tuple([SourceRefSchema]),
  [IPC.templates.writeSource]: z.tuple([SourceRefSchema, WriteSourceSchema]),
  [IPC.templates.createBlank]: z.tuple([AuthoringNameSchema]),
  [IPC.templates.freezeComposition]: z.tuple([FreezeCompositionSchema]),
  [IPC.templates.importComposition]: z.tuple([]),
  [IPC.templates.listCompositions]: z.tuple([]),
  [IPC.templates.openComposition]: z.tuple([CompositionPackageIdSchema]),
  [IPC.presets.list]: z.tuple([]),
  [IPC.presets.save]: z.tuple([SavePresetSchema]),
  [IPC.presets.remove]: z.tuple([PresetIdSchema]),
  [IPC.presets.importFile]: z.tuple([]),
  [IPC.presets.exportFile]: z.tuple([PresetIdSchema]),
  [IPC.project.open]: z.tuple([]),
  [IPC.project.openRequested]: z.tuple([OpenRequestTokenSchema]),
  [IPC.project.openRecent]: z.tuple([z.uuid()]),
  [IPC.project.save]: z.tuple([ProjectHandleSchema.nullable(), ProjectDataSchema]),
  [IPC.project.saveAs]: z.tuple([ProjectDataSchema]),
  [IPC.project.recents]: z.tuple([]),
  [IPC.host.commandResult]: z.tuple([HostCommandResultSchema]),
  [IPC.host.macMenuState]: z.tuple([MacMenuStateSchema]),
  [IPC.host.ready]: z.tuple([]),
  [IPC.folders.get]: z.tuple([]),
  [IPC.folders.choose]: z.tuple([FolderKindSchema]),
  [IPC.folders.reset]: z.tuple([FolderKindSchema]),
  [IPC.updates.state]: z.tuple([]),
  [IPC.updates.check]: z.tuple([]),
  [IPC.updates.download]: z.tuple([]),
  [IPC.updates.cancel]: z.tuple([]),
  [IPC.updates.install]: z.tuple([]),
  [IPC.cache.getThumb]: z.tuple([ResourceStampSchema, ThumbKeySchema]),
  [IPC.cache.putThumb]: z.tuple([ResourceStampSchema, ThumbKeySchema, ThumbPngSchema]),
  [IPC.cache.clear]: z.tuple([]),
  [IPC.cache.usage]: z.tuple([]),
} as const satisfies Record<InvokeChannel, z.ZodTuple>;

export type IpcArgs<C extends InvokeChannel> = z.infer<(typeof IPC_ARGS)[C]>;

export interface AppInfo {
  version: string;
  platform: string;
  userDataDir: string;
  /** 只在未打包且设置了 ALLAY_E2E_HOOKS 时为真：渲染进程据此装上测试钩子（docs/decisions.md M1） */
  testHooks: boolean;
  /** 系统首选语言（BCP 47），用于“跟随系统” */
  systemLocale: string;
}

export interface PickedFile {
  ref: string;
  name: string;
}
