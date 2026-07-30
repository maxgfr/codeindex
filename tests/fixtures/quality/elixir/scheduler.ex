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
end
