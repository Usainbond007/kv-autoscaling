from locust import LoadTestShape
from locustfile import VLLMUser  # Register the existing request tasks


class BurstShape(LoadTestShape):
    def tick(self):
        elapsed = self.get_run_time()

        if elapsed < 60:
            return (1, 1)
        if elapsed < 120:
            return (6, 2)
        if elapsed < 180:
            return (1, 2)
        return None
