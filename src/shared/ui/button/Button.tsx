import { forwardRef, type ButtonHTMLAttributes } from 'react';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'default' | 'outline' | 'ghost' | 'destructive';
  size?: 'default' | 'icon';
}

/** Workbench adaptation of the shadcn/ui action hierarchy, using native CSS tokens. */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'outline', size = 'default', className = '', type = 'button', ...props }, ref,
) {
  const appearance = { default: 'primary-button', outline: 'secondary-button', ghost: 'ghost-button', destructive: 'danger-button' }[variant];
  return <button ref={ref} type={type} data-ui="button" data-variant={variant} data-size={size}
    className={`${appearance}${size === 'icon' ? ' icon-button' : ''}${className ? ` ${className}` : ''}`} {...props} />;
});
