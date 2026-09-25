defmodule Worker.Scheduler do
  # Runs jobs with exponential backoff between retries.

  @max_attempts 5

  def start(queue) do
    dispatch(queue, @max_attempts)
  end

  def dispatch(spec, max) do
    reset()
    {:ok, spec, max}
  end

  defp reset do
    :ok
  end

  defmacro trace(expr) do
    expr
  end

  defguard is_attempt(n) when is_integer(n) and n > 0

  def retry(spec, n) when is_attempt(n) do
    dispatch(spec, n)
  end

  defp backoff(n) when n > 1, do: n * 2
end
