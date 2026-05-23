Add-Type -AssemblyName System.Drawing

$sizes = @(16, 48)

foreach ($s in $sizes) {
    $bmp = New-Object System.Drawing.Bitmap($s, $s)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = 'AntiAlias'
    
    # Gradient background
    $brush = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
        [System.Drawing.Point]::new(0, 0),
        [System.Drawing.Point]::new($s, $s),
        [System.Drawing.Color]::FromArgb(67, 56, 202),
        [System.Drawing.Color]::FromArgb(124, 58, 237)
    )
    $g.FillRectangle($brush, 0, 0, $s, $s)
    
    # Play triangle in cyan
    $cx = [int]($s / 2)
    $cy = [int]($s / 2)
    $ts = [int]($s * 0.3)
    $points = @(
        [System.Drawing.Point]::new($cx - [int]($ts * 0.4), $cy - [int]($ts * 0.5)),
        [System.Drawing.Point]::new($cx + [int]($ts * 0.6), $cy),
        [System.Drawing.Point]::new($cx - [int]($ts * 0.4), $cy + [int]($ts * 0.5))
    )
    $triBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(34, 211, 238))
    $g.FillPolygon($triBrush, $points)
    
    $g.Dispose()
    $outPath = "C:\Users\think\.gemini\antigravity\scratch\mediasniff\icons\icon$s.png"
    $bmp.Save($outPath, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
    Write-Host "Created icon$s.png"
}

Write-Host "Done!"
