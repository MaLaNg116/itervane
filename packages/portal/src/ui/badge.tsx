// Adapted from the shadcn/ui Base UI registry. See public/shadcn-LICENSE.txt.
import type { ComponentProps } from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from './cn.js';

const badgeVariants = cva('inline-flex w-fit max-w-full items-center rounded-md px-2 py-1 text-xs font-semibold [overflow-wrap:anywhere]', {
  variants: {
    variant: {
      default: 'bg-muted text-muted-foreground',
      info: 'bg-info/10 text-info',
      success: 'bg-success/10 text-success',
      warning: 'bg-warning/10 text-warning',
      destructive: 'bg-destructive/8 text-destructive',
    },
  },
  defaultVariants: { variant: 'default' },
});

export function Badge({ className, variant, ...props }: ComponentProps<'span'> & VariantProps<typeof badgeVariants>) {
  return <span data-slot="badge" className={cn(badgeVariants({ variant }), className)} {...props} />;
}
