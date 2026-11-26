// M7 导出完善里不需要 FFmpeg 的部分（docs/05-export.md 5.2、5.3、5.7）：命令行的构造（有无音频两种情况）、
// H.264 编码器参数、预设可用性、偶数修正、文件名、体积估算、剩余时间。编码与回读在 tests/export（pnpm test:export）。
import { describe, expect, it } from 'vitest';
import { H264_METADATA_BSF, PRESET_AUDIO_ARGS, colorFilter, ffmpegArgs, h264Bitrate, h264EncoderArgs } from '../../apps/desktop/src/main/export/ffmpeg-args';
import { buildInfo } from '../../apps/desktop/src/main/export/ffmpeg-locate';
import { TRIAL_FLAT_ERROR, TRIAL_FLAT_RATIO, TRIAL_MAX_ERROR, solidFrameError, trialArgs, trialDecodeArgs } from '../../apps/desktop/src/main/export/encoder-probe';
import {
  EXPORT_PRESETS,
  ExportStartSchema,
  estimateBytes,
  evenDimension,
  exportBaseName,
  frameTimecode,
  sanitizeFileName,
  H264_PROBE_CHECK,
  type H264Probe,
} from '../../apps/desktop/src/shared/export';
import { defaultSettingsFile, SettingsFileSchema } from '../../apps/desktop/src/shared/settings';

const base = { width: 1920, height: 1080, fps: 60, cutFrame: 33 } as const;
const INPUT = ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'rawvideo', '-pixel_format', 'rgba', '-video_size', '1920x1080', '-framerate', '60', '-i', 'pipe:0'];

describe('FFmpeg 命令行（5.3）', () => {
  it('① ProRes 4444：没有音频 / 有音频', () => {
    const none = ffmpegArgs({ ...base, preset: 'prores4444', output: 'o.mov.partial' });
    expect(none).toEqual([...INPUT, '-vf', colorFilter('yuva444p10le'), '-c:v', 'prores_ks', '-profile:v', '4444', '-alpha_bits', '16', '-vendor', 'apl0', '-metadata', 'comment=cut_frame=33', '-f', 'mov', 'o.mov.partial']);
    expect(none).not.toContain('-qscale:v');
    const withAudio = ffmpegArgs({ ...base, preset: 'prores4444', output: 'o.mov.partial', audio: 'mix.wav' });
    expect(withAudio.slice(0, INPUT.length + 2)).toEqual([...INPUT, '-i', 'mix.wav']);
    expect(withAudio).toEqual(expect.arrayContaining(['-c:a', 'pcm_s16le']));
    expect(withAudio.indexOf('-c:a')).toBeGreaterThan(withAudio.indexOf('apl0'));
  });

  it('② PNG 序列：音频不经 FFmpeg（另存 WAV），有没有音频命令行都一样', () => {
    const none = ffmpegArgs({ ...base, preset: 'png-sequence', output: 'd/n_%05d.png' });
    expect(none).toEqual([...INPUT, '-c:v', 'png', '-start_number', '0', '-f', 'image2', 'd/n_%05d.png']);
    expect(ffmpegArgs({ ...base, preset: 'png-sequence', output: 'd/n_%05d.png', audio: 'mix.wav' })).toEqual(none);
  });

  it('③ WebM VP9：没有音频 / 有音频', () => {
    const none = ffmpegArgs({ ...base, preset: 'webm-vp9', output: 'o.webm.partial' });
    expect(none).toEqual([
      ...INPUT,
      '-vf',
      colorFilter('yuva420p'),
      '-c:v',
      'libvpx-vp9',
      '-b:v',
      '0',
      '-crf',
      '24',
      '-row-mt',
      '1',
      '-auto-alt-ref',
      '0',
      '-metadata',
      'comment=cut_frame=33',
      '-f',
      'webm',
      'o.webm.partial',
    ]);
    const withAudio = ffmpegArgs({ ...base, preset: 'webm-vp9', output: 'o.webm.partial', audio: 'mix.wav' });
    expect(withAudio).toContain('mix.wav');
    expect(withAudio.join(' ')).toContain('-c:a libopus -b:a 160k');
  });

  it('④ 绿幕 MP4：没有音频 / 有音频；一律加 h264_metadata 和 +faststart', () => {
    const none = ffmpegArgs({ ...base, preset: 'greenscreen-mp4', output: 'o.mp4.partial', h264Encoder: 'h264_nvenc' });
    expect(none).toEqual([
      ...INPUT,
      '-vf',
      colorFilter('yuv420p'),
      '-c:v',
      'h264_nvenc',
      '-rc',
      'vbr',
      '-cq',
      '18',
      '-b:v',
      '0',
      '-bsf:v',
      H264_METADATA_BSF,
      '-movflags',
      '+faststart',
      '-metadata',
      'comment=cut_frame=33',
      '-f',
      'mp4',
      'o.mp4.partial',
    ]);
    expect(H264_METADATA_BSF).toBe('h264_metadata=colour_primaries=1:transfer_characteristics=1:matrix_coefficients=1:video_full_range_flag=0');
    const withAudio = ffmpegArgs({ ...base, preset: 'greenscreen-mp4', output: 'o.mp4.partial', h264Encoder: 'h264_mf', audio: 'mix.wav' });
    expect(withAudio.join(' ')).toContain('-c:a aac -b:a 192k');
    expect(withAudio.join(' ')).toContain('-c:v h264_mf -b:v 20000000');
    expect(() => ffmpegArgs({ ...base, preset: 'greenscreen-mp4', output: 'o.mp4.partial' })).toThrow();
  });

  it('叠加层（没有剪辑点）不写 comment', () => {
    for (const preset of EXPORT_PRESETS) {
      const args = ffmpegArgs({ ...base, cutFrame: null, preset, output: 'x', h264Encoder: 'h264_mf' });
      expect(args).not.toContain('-metadata');
    }
  });

  it('每个预设的音频参数（M6b 接上音频时用）', () => {
    expect(PRESET_AUDIO_ARGS).toEqual({
      prores4444: ['-c:a', 'pcm_s16le'],
      'png-sequence': [],
      'webm-vp9': ['-c:a', 'libopus', '-b:a', '160k'],
      'greenscreen-mp4': ['-c:a', 'aac', '-b:a', '192k'],
    });
  });

  it('H.264 编码器参数（5.3 的表）；码率按像素数 × 帧率等比缩放', () => {
    expect(h264EncoderArgs('h264_qsv', 1920, 1080, 60)).toEqual(['-global_quality', '18']);
    expect(h264EncoderArgs('h264_amf', 1920, 1080, 60)).toEqual(['-rc', 'cqp', '-qp_i', '18', '-qp_p', '18']);
    expect(h264EncoderArgs('libx264', 1920, 1080, 60)).toEqual(['-crf', '16', '-preset', 'medium']);
    expect(h264EncoderArgs('libopenh264', 1920, 1080, 60)).toEqual(['-b:v', '20000000']);
    expect(h264EncoderArgs('h264_videotoolbox', 1920, 1080, 60)).toEqual(['-b:v', '20000000', '-allow_sw', '1']);
    expect(h264Bitrate(1920, 1080, 60)).toBe(20_000_000);
    expect(h264Bitrate(3840, 2160, 60)).toBe(80_000_000);
    expect(h264Bitrate(1920, 1080, 30)).toBe(10_000_000);
  });

  it('试编码：256×144、12 帧运动接 4 帧纯绿，与导出相同的色彩滤镜和比特流滤镜，编码器参数取 1080p60 导出时的', () => {
    const args = trialArgs('h264_mf', 'probe.h264');
    const line = args.join(' ');
    expect(line).toContain('testsrc2=s=256x144:r=30');
    expect(line).toContain('color=c=0x00ff00:s=256x144:r=30');
    expect(line).toContain('trim=end_frame=12');
    expect(line).toContain('-frames:v 16');
    expect(line).toContain(colorFilter('yuv420p'));
    expect(args).toContain(H264_METADATA_BSF);
    expect(line).toContain(h264EncoderArgs('h264_mf', 1920, 1080, 60).join(' '));
    expect(args.slice(-4)).toEqual(['-f', 'h264', '-y', 'probe.h264']);
    expect(trialArgs('h264_amf', 'x').join(' ')).toContain('-rc cqp -qp_i 18 -qp_p 18');
    expect(trialDecodeArgs('probe.h264')).toEqual(['-hide_banner', '-loglevel', 'error', '-f', 'h264', '-i', 'probe.h264', '-f', 'rawvideo', '-pix_fmt', 'rgba', 'pipe:1']);
  });

  it('试编码里运动之后的纯色帧：和 T-EXP-7 判绿幕末帧同一口径（超过 4 的像素 < 0.1%，没有超过 16 的）', () => {
    expect([TRIAL_FLAT_ERROR, TRIAL_FLAT_RATIO, TRIAL_MAX_ERROR]).toEqual([4, 0.001, 16]);
    expect(solidFrameError(new Uint8Array([0, 255, 0, 255, 0, 255, 0, 255]))).toEqual({ worst: 0, over: 0 });
    expect(solidFrameError(new Uint8Array([3, 251, 2, 255, 0, 255, 0, 0]))).toEqual({ worst: 4, over: 0 });
    // 每个像素取三个通道里最大的差，超过 4 的按像素数
    expect(solidFrameError(new Uint8Array([5, 250, 0, 255, 42, 213, 0, 255]))).toEqual({ worst: 42, over: 2 });
  });
});

describe('预设可用性', () => {
  const caps = (encoders: string[]) => ({ available: true, version: 'ffmpeg version n9', encoders: new Set(encoders) });
  const probe = (encoder: string | null, version = 'ffmpeg version n9'): H264Probe => ({ ffmpegVersion: version, check: H264_PROBE_CHECK, encoder, attempts: [], probedAt: '2026-11-13T00:00:00.000Z' });

  it('FFmpeg 不能用：全部禁用', () => {
    const info = buildInfo({ available: false, version: null, encoders: new Set() }, null);
    for (const p of EXPORT_PRESETS) expect(info.blockers[p]).toBe('ffmpeg-missing');
  });
  it('缺编码器的预设禁用', () => {
    const info = buildInfo(caps(['prores_ks', 'png', 'h264_mf']), null);
    expect(info.presets).toEqual({ prores4444: true, 'png-sequence': true, 'webm-vp9': false, 'greenscreen-mp4': true });
    expect(info.blockers['webm-vp9']).toBe('encoder-missing');
  });
  it('绿幕：没有候选 → no-h264；探测全部失败 → no-h264；探测成功 → 可用；FFmpeg 版本变了缓存作废', () => {
    expect(buildInfo(caps(['prores_ks']), null).blockers['greenscreen-mp4']).toBe('no-h264');
    expect(buildInfo(caps(['h264_amf']), probe(null)).blockers['greenscreen-mp4']).toBe('no-h264');
    const ok = buildInfo(caps(['h264_mf']), probe('h264_mf'));
    expect(ok.presets['greenscreen-mp4']).toBe(true);
    expect(ok.h264?.encoder).toBe('h264_mf');
    const stale = buildInfo(caps(['h264_mf']), probe(null, 'ffmpeg version n8'));
    expect(stale.h264).toBeNull();
    expect(stale.presets['greenscreen-mp4']).toBe(true);
    // 旧的探测方法（不核对画质）写下的缓存没有 check：当作过期，导出前重新探测
    const legacy = probe('h264_amf');
    delete legacy.check;
    const unchecked = buildInfo(caps(['h264_amf', 'h264_mf']), legacy);
    expect(unchecked.h264).toBeNull();
    expect(unchecked.presets['greenscreen-mp4']).toBe(true);
  });
  it('设置文件：导出这一项坏了只回退它自己', () => {
    const parsed = SettingsFileSchema.parse({ ...defaultSettingsFile(), export: { folder: 42, h264: null } });
    expect(parsed.export).toEqual({ folder: null, h264: null });
    expect(SettingsFileSchema.parse({ formatVersion: 1, ui: {} }).export).toEqual({ folder: null, h264: null });
  });
});

describe('输出设置（5.2）', () => {
  it('T-EXP-8 自定义分辨率修正为 64–4096 的偶数', () => {
    expect(evenDimension(1001)).toBe(1000);
    expect(evenDimension(563)).toBe(562);
    expect(evenDimension(1920)).toBe(1920);
    expect(evenDimension(10)).toBe(64);
    expect(evenDimension(9999)).toBe(4096);
    expect(evenDimension(Number.NaN)).toBe(64);
    // 主进程的边界也只收偶数
    const req = { preset: 'greenscreen-mp4', fps: 60, totalFrames: 10, cutFrame: null, suggestedName: 'x' } as const;
    expect(ExportStartSchema.safeParse({ ...req, width: 1001, height: 563 }).success).toBe(false);
    expect(ExportStartSchema.safeParse({ ...req, width: evenDimension(1001), height: evenDimension(563) }).success).toBe(true);
  });

  it('文件名：{工程名}_{模板名}_{宽}x{高}_{帧率}fps，去掉文件系统不允许的字符', () => {
    expect(exportBaseName('我的工程', '方块擦除', 1920, 1080, 60)).toBe('我的工程_方块擦除_1920x1080_60fps');
    expect(sanitizeFileName('a/b\\c:d*e?f"g<h>i|j')).toBe('a_b_c_d_e_f_g_h_i_j');
    expect(sanitizeFileName('..\\..\\Windows\\x')).toBe('.._.._Windows_x');
    expect(sanitizeFileName('CON')).toBe('export');
    expect(sanitizeFileName('name. ')).toBe('name');
  });

  it('体积估算按 5.9 的实测折算', () => {
    const frames = 120;
    expect(estimateBytes('prores4444', 1920, 1080, frames)).toBe(107e6);
    expect(estimateBytes('png-sequence', 1920, 1080, frames)).toBe(5e6);
    expect(estimateBytes('webm-vp9', 1920, 1080, frames)).toBe(2e6);
    // 20 Mbps × 2 秒
    expect(estimateBytes('greenscreen-mp4', 1920, 1080, frames)).toBe(5e6);
    expect(estimateBytes('prores4444', 3840, 2160, frames)).toBe(4 * 107e6);
  });

  it('剪辑点的时间码 分:秒:帧', () => {
    expect(frameTimecode(33, 60)).toBe('00:00:33');
    expect(frameTimecode(61, 60)).toBe('00:01:01');
    expect(frameTimecode(3601, 60)).toBe('01:00:01');
  });
});
