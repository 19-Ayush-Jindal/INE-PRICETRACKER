// A plain table of every scrape attempt for the selected product - success,
// retried, and failed all show up here honestly, per the assignment's
// "failures must be recorded, not hidden" requirement.

const STATUS_LABEL = {
  success: 'Success',
  retried: 'Retried',
  failed: 'Failed',
};

export default function ScrapeLog({ logs }) {
  if (!logs || logs.length === 0) {
    return <p className="empty-state">No scrape attempts logged yet.</p>;
  }

  return (
    <table className="scrape-log">
      <thead>
        <tr>
          <th>When</th>
          <th>Attempt</th>
          <th>Outcome</th>
          <th>Details</th>
          <th>Duration</th>
        </tr>
      </thead>
      <tbody>
        {logs.map((log, i) => (
          <tr key={i} className={`status-${log.status}`}>
            <td>{new Date(log.started_at).toLocaleString()}</td>
            <td>#{log.attempt_number}</td>
            <td>
              <span className={`status-badge status-badge-${log.status}`}>
                {STATUS_LABEL[log.status] || log.status}
              </span>
            </td>
            <td>{log.message}{log.http_status ? ` (HTTP ${log.http_status})` : ''}</td>
            <td>{log.duration_ms != null ? `${log.duration_ms}ms` : '-'}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
