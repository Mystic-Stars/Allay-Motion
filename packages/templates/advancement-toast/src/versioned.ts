import type { ParamValue, SetupContext, TemplateInstance } from '@allay/template-sdk';
import { setupJavaToast } from './java-toast';
import type { JavaToastProfile } from './java-timing';

export function toastProfile(value: ParamValue | undefined): JavaToastProfile | undefined {
  return value === 'javaAchievement' || value === 'javaAdvancement' || value === 'javaAdvancement263' ? value : undefined;
}

export function setupVersionedToast(ctx: SetupContext, profile: JavaToastProfile): Promise<TemplateInstance> {
  return setupJavaToast(ctx, profile);
}
