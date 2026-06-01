import { useAgencyConfig } from '../contexts/AgencyConfigContext'
import { useAgencyLogo } from '../contexts/AgencyLogoContext'

// Renders the uploaded agency logo, falling back to the agency name when no
// logo has been set so the header is never empty.
export function AgencyLogoMark({
  imgClassName = 'h-8 w-auto max-w-[160px] object-contain',
  fallbackClassName = 'text-brand text-lg font-bold',
}: {
  imgClassName?: string
  fallbackClassName?: string
}) {
  const { config } = useAgencyConfig()
  const { logo } = useAgencyLogo()

  if (logo?.signed_url) {
    return <img src={logo.signed_url} alt={config.identity.name} className={imgClassName} />
  }

  return <span className={fallbackClassName}>{config.identity.name}</span>
}
