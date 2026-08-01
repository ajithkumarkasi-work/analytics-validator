import { useState, useRef, useEffect, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'

type AttributeTooltipProps = {
	attribute: string
	sampleValues: string[]
	children: React.ReactNode
}

export const AttributeTooltip = ({ attribute, sampleValues, children }: AttributeTooltipProps) => {
	const [isOpen, setIsOpen] = useState(false)
	const [position, setPosition] = useState<{ top: number; left: number } | null>(null)
	const tooltipRef = useRef<HTMLDivElement>(null)
	const triggerRef = useRef<HTMLSpanElement>(null)

	useEffect(() => {
		if (!isOpen) return

		const handleClickOutside = (event: MouseEvent) => {
			if (
				tooltipRef.current &&
				!tooltipRef.current.contains(event.target as Node) &&
				triggerRef.current &&
				!triggerRef.current.contains(event.target as Node)
			) {
				setIsOpen(false)
			}
		}

		const handleScroll = () => {
			setIsOpen(false)
		}

		document.addEventListener('mousedown', handleClickOutside)
		document.addEventListener('scroll', handleScroll, true)
		
		return () => {
			document.removeEventListener('mousedown', handleClickOutside)
			document.removeEventListener('scroll', handleScroll, true)
		}
	}, [isOpen])

	const handleClick = (event: React.MouseEvent) => {
		event.stopPropagation()
		
		if (!isOpen && triggerRef.current) {
			const rect = triggerRef.current.getBoundingClientRect()
			const viewportWidth = window.innerWidth
			const viewportHeight = window.innerHeight
			
			// Estimated tooltip dimensions
			const tooltipWidth = 300 // approximate max-width
			const tooltipHeight = 250 // approximate height with scrolling
			
			// Calculate horizontal position
			let left = rect.left
			// If tooltip would overflow right edge, align to right side of trigger
			if (left + tooltipWidth > viewportWidth) {
				left = Math.max(10, viewportWidth - tooltipWidth - 10)
			}
			
			// Calculate vertical position
			let top = rect.bottom + 4
			// If tooltip would overflow bottom, show above the trigger instead
			if (top + tooltipHeight > viewportHeight) {
				top = rect.top - tooltipHeight - 4
				// If it still doesn't fit above, position at top of viewport
				if (top < 10) {
					top = 10
				}
			}
			
			setPosition({ top, left })
		}
		
		setIsOpen(!isOpen)
	}

	const handleKeyDown = (event: React.KeyboardEvent) => {
		if (event.key === 'Enter' || event.key === ' ') {
			event.preventDefault()
			handleClick(event as unknown as React.MouseEvent)
		}
	}

	const handleCopy = async () => {
		const text = sampleValues.join('\n')
		try {
			await navigator.clipboard.writeText(text)
			// Could add a success indicator here
		} catch (err) {
			console.error('Failed to copy:', err)
		}
	}

	const tooltipStyle: CSSProperties = position
		? {
				position: 'fixed',
				top: `${position.top}px`,
				left: `${position.left}px`,
				zIndex: 9999
			}
		: {}

	return (
		<>
			<span
				ref={triggerRef}
				onClick={handleClick}
				onKeyDown={handleKeyDown}
				role="button"
				tabIndex={0}
				aria-expanded={isOpen}
				className="attribute-tooltip-trigger"
			>
				{children}
			</span>

			{isOpen && position && createPortal(
				<div ref={tooltipRef} className="attribute-tooltip" style={tooltipStyle}>
					<div className="attribute-tooltip-header">
						<span className="attribute-tooltip-title">{attribute}</span>
						<button
							type="button"
							className="attribute-tooltip-close"
							onClick={() => setIsOpen(false)}
							aria-label="Close"
						>
							×
						</button>
					</div>
					<div className="attribute-tooltip-body">
						{sampleValues.length > 0 ? (
							<>
								<div className="attribute-tooltip-label">
									Sample Values ({sampleValues.length})
									<button
										type="button"
										className="attribute-tooltip-copy-btn"
										onClick={handleCopy}
										title="Copy all values"
										aria-label="Copy all values"
									>
										<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
											<rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
											<path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
										</svg>
									</button>
								</div>
								<ul className="attribute-tooltip-list">
									{sampleValues.map((value) => (
										<li key={`${attribute}-${value}`} className="attribute-tooltip-item">
											<code>{value}</code>
										</li>
									))}
								</ul>
							</>
						) : (
							<div className="attribute-tooltip-empty">No values found</div>
						)}
					</div>
				</div>,
				document.body
			)}
		</>
	)
}
