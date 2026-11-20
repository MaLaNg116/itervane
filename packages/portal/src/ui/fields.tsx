// Adapted from the shadcn/ui Base UI input, textarea and native-select.
// See public/shadcn-LICENSE.txt.
import type { ComponentProps } from 'react';
import { Input as InputPrimitive } from '@base-ui/react/input';
import { cn } from './cn.js';

const control = 'min-h-11 w-full min-w-0 rounded-lg border border-solid border-control bg-card px-3 py-2 text-foreground placeholder:text-muted-foreground aria-invalid:border-destructive disabled:opacity-60';

export function Input({ className, ...props }: ComponentProps<'input'>) {
  return <InputPrimitive data-slot="input" className={cn(control, className)} {...props} />;
}

export function Textarea({ className, ...props }: ComponentProps<'textarea'>) {
  return <textarea data-slot="textarea" className={cn(control, 'resize-y', className)} {...props} />;
}

export function NativeSelect({ className, ...props }: ComponentProps<'select'>) {
  return <select data-slot="native-select" className={cn(control, 'cursor-pointer', className)} {...props} />;
}
