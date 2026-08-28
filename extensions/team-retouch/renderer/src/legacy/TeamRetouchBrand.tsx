const teamRetouchIconUrl = new URL('../../team-retouch.svg', import.meta.url).href;

export const TeamRetouchBrand = () => (
  <div className="team-brand flex shrink-0 items-center gap-1.5">
    <img className="team-brand-icon h-6 w-6" src={teamRetouchIconUrl} alt="" aria-hidden="true"/>
    <h2 className="team-brand-title whitespace-nowrap text-[13px] font-bold text-slate-900">团片协作</h2>
  </div>
);
