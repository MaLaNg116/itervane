// Adapted from the shadcn/ui Base UI registry. See public/shadcn-LICENSE.txt.
import type { ComponentProps } from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from './cn.js';

const alertVariants = cva('w-full rounded-lg border border-solid border-l-4 px-4 py-3 text-sm [overflow-wrap:anywhere]', {
  variants: {
    variant: {
      info: 'border-info/30 border-l-info bg-info/5 text-foreground',
      warning: 'border-warning/35 border-l-warning bg-warning/5 text-foreground',
      success: 'border-success/30 border-l-success bg-success/5 text-foreground',
      destructive: 'border-destructive/30 border-l-destructive bg-destructive/5 text-foreground',
    },
  },
  defaultVariants: { variant: 'info' },
});

export function Alert({ className, variant, ...props }: ComponentProps<'div'> & VariantProps<typeof alertVariants>) {
  return <div data-slot="alert" className={cn(alertVariants({ variant }), className)} {...props} />;
}

export function AlertTitle({ className, ...props }: ComponentProps<'div'>) {
  return <div data-slot="alert-title" className={cn('font-semibold', className)} {...props} />;
}

export function AlertDescription({ className, ...props }: ComponentProps<'div'>) {
  return <div data-slot="alert-description" className={cn('mt-1 text-muted-foreground [&_p]:my-1', className)} {...props} />;
}
