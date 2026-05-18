# Wait for servers to start
Start-Sleep -Seconds 8

# Test login
$body = @{
    username = "Syed Junaid K"
    password = "admin123"
} | ConvertTo-Json

try {
    $response = Invoke-RestMethod -Uri "http://127.0.0.1:8000/api/auth/login" `
        -Method Post `
        -ContentType "application/json" `
        -Body $body
    
    Write-Host "✅ Login successful!"
    Write-Host "Token: $($response.token.Substring(0, 20))..."
    Write-Host "User: $($response.user.username)"
    Write-Host "Role: $($response.user.role)"
} catch {
    Write-Host "❌ Login failed: $($_.Exception.Message)"
    Write-Host "Response: $($_.ErrorDetails.Message)"
}
