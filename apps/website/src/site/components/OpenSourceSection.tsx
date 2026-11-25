// 开源一节（片尾字幕排版）：左侧为 GPL-3.0 仓库入口与 3D 体素时间线雕塑槽位，右侧为自托管真实开发者头像列表。
import { buttonVariants } from '@allay/ui/components/button';
import { ArrowUpRight, GithubLogo } from '@phosphor-icons/react';
import type { CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import { DEVELOPERS, LICENSE_NAME, REPO_URL, SECTION } from '../links';
import { useReveal } from '../motion/interactions';

function Avatar({ src, name }: { src: string; name: string }) {
  return (
    <img
      src={src}
      alt=""
      width={64}
      height={64}
      loading="lazy"
      decoding="async"
      className="size-16 shrink-0 rounded-[18px] bg-control object-cover ring-1 ring-[color-mix(in_srgb,var(--foreground)_14%,transparent)] transition-transform duration-500 ease-(--ease-expo) group-hover:scale-105 group-hover:-rotate-3"
      data-testid="avatar"
      data-name={name}
    />
  );
}

export function OpenSourceSection() {
  const { t } = useTranslation();
  const left = useReveal<HTMLDivElement>();
  const right = useReveal<HTMLDivElement>(0.15);

  return (
    <section id={SECTION.open} data-tl-clip="openSource" data-tl-color="var(--stage-hold)" aria-labelledby="open-title" className="relative pt-28 pb-16">
      <div className="ruler wrap pointer-events-none absolute inset-x-0 top-0 opacity-60" aria-hidden="true" />
      <div className="wrap grid gap-16 lg:grid-cols-[1.15fr_1fr] lg:gap-24">
        <div ref={left} className="reveal">
          <p className="t-mono text-fg-subtle">{t('site.open.kicker')}</p>
          <h2 id="open-title" className="t-h2 mt-4 max-w-[10em]">
            {t('site.open.title')}
          </h2>
          <p className="t-lead mt-6 max-w-[30em]">{t('site.open.lead')}</p>
          <div className="mt-10 flex flex-wrap items-center gap-5">
            <a href={REPO_URL} target="_blank" rel="noreferrer noopener" className={buttonVariants({ size: 'lg' })} data-testid="cta-repo">
              <GithubLogo size={16} weight="fill" />
              {t('site.open.repo')}
            </a>
            <span className="t-mono text-[11px] text-fg-subtle">
              {t('site.open.license')} · {LICENSE_NAME}
            </span>
          </div>
          <div data-voxel-slot="timeline" aria-hidden="true" className="pointer-events-none mt-16 hidden h-[clamp(160px,18vw,240px)] w-full max-w-[600px] lg:block" />
        </div>

        <div ref={right} className="reveal relative">
          <span data-allay-anchor="credits" data-allay-facing="left" className="absolute -top-10 right-10 size-1" aria-hidden="true" />
          <p className="t-mono text-primary-text">{t('site.open.credits')}</p>
          <p className="t-mono mt-8 text-[10.5px] text-fg-subtle">{t('site.open.developersLabel')}</p>
          <ul className="mt-4 divide-y divide-[var(--site-line)] border-y border-[var(--site-line)]" data-testid="team">
            {DEVELOPERS.map((d, i) => {
              const body = (
                <>
                  <Avatar src={d.avatar} name={d.name} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[clamp(22px,2.2vw,32px)] font-semibold tracking-[-0.03em]">{d.name}</span>
                    {d.url && <span className="t-mono mt-1 block truncate text-[10.5px] text-fg-subtle">{d.url.replace('https://', '')}</span>}
                  </span>
                  {d.url && (
                    <ArrowUpRight
                      size={20}
                      className="shrink-0 text-fg-faint transition-[color,transform] duration-300 group-hover:translate-x-0.5 group-hover:-translate-y-0.5 group-hover:text-primary-text"
                    />
                  )}
                </>
              );
              return (
                <li key={d.name} style={{ '--i': i } as CSSProperties}>
                  {d.url ? (
                    <a href={d.url} target="_blank" rel="noreferrer noopener" className="group link-focus flex items-center gap-5 rounded-lg py-5">
                      {body}
                    </a>
                  ) : (
                    <div className="group flex items-center gap-5 py-5">{body}</div>
                  )}
                </li>
              );
            })}
          </ul>
          <p className="mt-4 text-[12px] text-fg-subtle">{t('site.open.claudeNote')}</p>
        </div>
      </div>
    </section>
  );
}
